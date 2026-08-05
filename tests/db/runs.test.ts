// R-03 fix round (Finding 2, "deferred item 11"): `createDrizzleRunsRepo`'s SQL had no test
// at all — tests/llm.test.ts only ever injects a fake `RunsRepo`, so nothing exercised the
// real `runs` UPDATE/INSERT/SELECT SQL against a real Postgres. This suite is that missing
// coverage: the rounding line, accumulation across two `recordUsage` calls, the
// trailing-spend `sum`/`gt` query, and the no-row error path the reviewer reproduced live.
// Provisions its own scratch database (see tests/db/schema.test.ts for the rationale;
// provisioning itself lives in tests/db/scratch-database.ts).
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runs } from '../../db/schema.js';
import { ConfigError } from '../../lib/errors.js';
import { computeCostUsd, createDrizzleRunsRepo, type RunsRepo } from '../../lib/llm.js';
import { setupScratchDatabase, teardownScratchDatabase, type ScratchDatabase } from './scratch-database.js';

let handle: ScratchDatabase;
let repo: RunsRepo;

beforeAll(async () => {
  handle = await setupScratchDatabase('runs_test');
  repo = createDrizzleRunsRepo(handle.target.db);
}, 30_000);

afterAll(async () => {
  await teardownScratchDatabase(handle);
}, 30_000);

describe('createRun', () => {
  it('inserts a runs row and returns its id, with the documented defaults intact', async () => {
    const runId = await repo.createRun('extract');

    const [row] = await handle.target.db.select().from(runs).where(eq(runs.id, runId));
    expect(row).toBeDefined();
    expect(row?.stage).toBe('extract');
    expect(row?.status).toBe('running');
    expect(row?.inputTokens).toBeNull();
    expect(row?.outputTokens).toBeNull();
    expect(row?.costUsd).toBeNull();
    expect(row?.counts).toEqual({});
    expect(row?.errors).toEqual([]);
  });
});

describe('recordUsage — the no-row error path (Finding 2)', () => {
  it('throws ConfigError with the runId in context when no runs row matches, and writes nothing', async () => {
    // A syntactically valid UUID that was never inserted — distinguishes "no matching row"
    // from "malformed id", which would fail differently (an invalid-input-syntax error from
    // Postgres itself, not the loud-failure path this fix adds).
    const missingRunId = randomUUID();
    let thrown: unknown;

    try {
      await repo.recordUsage(missingRunId, {
        model: 'claude-haiku-4-5',
        inputTokens: 10,
        outputTokens: 5,
        costUsd: 0.01,
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(ConfigError);
    expect((thrown as ConfigError).context).toEqual({ runId: missingRunId });

    const rows = await handle.target.db.select().from(runs).where(eq(runs.id, missingRunId));
    expect(rows).toHaveLength(0);
  });
});

describe('recordUsage — rounding and accumulation against real SQL (Finding 2, deferred item 11)', () => {
  it('rounds cost to 4 decimal places at the point of persistence', async () => {
    const runId = await repo.createRun('extract');
    // 3 tokens at Haiku's $0.50/1M input rate is $0.0000015 — well below numeric(10,4)'s
    // resolution, so the persisted value must be the *rounded* figure (0.0000), not the raw
    // computed cost, and must not throw or truncate unexpectedly on write.
    const costUsd = computeCostUsd('claude-haiku-4-5', { input_tokens: 3, output_tokens: 0 });

    await repo.recordUsage(runId, { model: 'claude-haiku-4-5', inputTokens: 3, outputTokens: 0, costUsd });

    const [row] = await handle.target.db.select().from(runs).where(eq(runs.id, runId));
    expect(row?.costUsd).toBe('0.0000');
  });

  it('accumulates tokens and cost across two recordUsage calls on the same run', async () => {
    const runId = await repo.createRun('synthesize');
    const firstCostUsd = computeCostUsd('claude-sonnet-5', { input_tokens: 1000, output_tokens: 200 });
    const secondCostUsd = computeCostUsd('claude-sonnet-5', { input_tokens: 500, output_tokens: 100 });
    // Each call's cost is rounded individually before being added in SQL (composer
    // resolution #4, see lib/llm.ts) — so the expected total is the sum of two
    // already-rounded figures, not a single rounding of the raw sum.
    const expectedTotal =
      Math.round(firstCostUsd * 10_000) / 10_000 + Math.round(secondCostUsd * 10_000) / 10_000;

    await repo.recordUsage(runId, {
      model: 'claude-sonnet-5',
      inputTokens: 1000,
      outputTokens: 200,
      costUsd: firstCostUsd,
    });
    await repo.recordUsage(runId, {
      model: 'claude-sonnet-5',
      inputTokens: 500,
      outputTokens: 100,
      costUsd: secondCostUsd,
    });

    const [row] = await handle.target.db.select().from(runs).where(eq(runs.id, runId));
    expect(row?.model).toBe('claude-sonnet-5');
    expect(row?.inputTokens).toBe(1500);
    expect(row?.outputTokens).toBe(300);
    expect(Number(row?.costUsd)).toBeCloseTo(expectedTotal, 4);
  });
});

describe('getTrailingSpendUsd — the real sum/gt query (Finding 2, deferred item 11)', () => {
  // `getTrailingSpendUsd` has no upper bound at `now` — it is `WHERE started_at > cutoff`,
  // not `BETWEEN cutoff AND now` (see lib/llm.ts) — so it would also sum the `createRun`/
  // `recordUsage` rows the describe blocks above left behind, which carry the real *actual*
  // clock time via `defaultNow()`. A dedicated scratch database, provisioned and torn down
  // just for this describe block, is what keeps this suite's sum assertions exact instead of
  // dependent on execution order or on how far apart "now" and the real wall clock are.
  let trailingHandle: ScratchDatabase;
  let trailingRepo: RunsRepo;

  beforeAll(async () => {
    trailingHandle = await setupScratchDatabase('runs_test_trailing');
    trailingRepo = createDrizzleRunsRepo(trailingHandle.target.db);
  }, 30_000);

  afterAll(async () => {
    await teardownScratchDatabase(trailingHandle);
  }, 30_000);

  it('sums only runs whose started_at falls within the trailing window, ignoring older rows', async () => {
    const now = new Date('2026-08-04T00:00:00.000Z');
    const withinWindow = new Date('2026-07-20T00:00:00.000Z'); // 15 days back
    const outsideWindow = new Date('2026-06-01T00:00:00.000Z'); // ~64 days back

    // Direct inserts (bypassing createRun/recordUsage) so startedAt and costUsd can be
    // pinned exactly — this is the one place in the suite that reaches past RunsRepo into
    // the schema directly, since RunsRepo's own API has no way to backdate a run.
    await trailingHandle.target.db.insert(runs).values([
      { stage: 'extract', startedAt: withinWindow, costUsd: '12.5000' },
      { stage: 'extract', startedAt: outsideWindow, costUsd: '999.0000' },
    ]);

    const trailingSpendUsd = await trailingRepo.getTrailingSpendUsd(30, now);

    expect(trailingSpendUsd).toBe(12.5);
  });

  it('returns 0 when no runs rows fall inside the window at all', async () => {
    const farFuture = new Date('2099-01-01T00:00:00.000Z');
    const trailingSpendUsd = await trailingRepo.getTrailingSpendUsd(30, farFuture);
    expect(trailingSpendUsd).toBe(0);
  });
});
