// Phase 0 smoke test. Drives every seam at its public boundary against real
// infrastructure — a real Postgres, a real local HTTP server — without spending
// a cent on the Anthropic API.
//
// Run: npx tsx --env-file=.env smoke.ts
//
// Not part of `pnpm verify`. This is the manual "is the foundation actually
// alive" check; the test suite is the mechanical gate.

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { sql } from 'drizzle-orm';

import { AppError, BudgetExceededError, ConfigError } from './lib/errors.js';
import { bootConfig, loadConfig } from './lib/config.js';
import { assertBudget, evaluateBudget } from './lib/budget.js';
import { createNetClient } from './lib/net.js';
import { assertAllowedModel, computeCostUsd, RATES } from './lib/llm.js';
import { runMigrations } from './db/migrate.js';
import { seed } from './db/seed.js';
import { createDb } from './db/index.js';

let failures = 0;

function check(label: string, passed: boolean, detail = ''): void {
  const mark = passed ? 'PASS' : 'FAIL';
  if (!passed) failures += 1;
  console.log(`  [${mark}] ${label}${detail ? ` — ${detail}` : ''}`);
}

async function expectRejection(label: string, fn: () => Promise<unknown>, match: RegExp): Promise<void> {
  try {
    await fn();
    check(label, false, 'expected a rejection, got success');
  } catch (error) {
    // Drizzle wraps driver errors, so the underlying Postgres message (the one that
    // actually proves the trigger fired) is on `.cause`, not on the wrapper.
    const wrapper = error instanceof Error ? error.message : String(error);
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : '';
    const message = `${wrapper} ${cause}`;
    check(label, match.test(message), match.test(message) ? '' : `got: ${wrapper}`);
  }
}

function section(name: string): void {
  console.log(`\n${name}`);
}

async function main(): Promise<void> {
  section('1. Config (F-03) — validation, fail-fast, secret redaction');

  const config = bootConfig();
  check('bootConfig() loads', typeof config.databaseUrl === 'string');
  check('budget ceiling defaults/parses', config.budgetCeilingUsd === 70, `= ${config.budgetCeilingUsd}`);

  // The whole point of F-03's redaction: secrets must not survive ANY ordinary
  // serialization route, including the spread that lib/log.ts does internally.
  const serialized = [
    JSON.stringify(config),
    JSON.stringify({ ...config }),
    JSON.stringify(Object.entries(config)),
    String(config),
  ].join('|');
  const secret = config.anthropicApiKey;
  check('secret absent from stringify/spread/entries/coerce', !serialized.includes(secret));
  check('but readable by legitimate consumers', secret.length > 0);

  // Missing required vars must report EVERY problem at once, not just the first.
  try {
    loadConfig({});
    check('missing-var boot fails loudly', false, 'expected ConfigError');
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const namesBoth = message.includes('DATABASE_URL') && message.includes('ANTHROPIC_API_KEY');
    check('missing-var boot names every offender at once', error instanceof ConfigError && namesBoth);
  }

  section('2. Database (F-02) — migrations, seed idempotency, append-only');

  await runMigrations(config.databaseUrl);
  check('migrations apply', true);

  const first = await seed(config.databaseUrl);
  const second = await seed(config.databaseUrl);
  // Idempotent by design: a fresh database inserts 20, an already-seeded one inserts 0.
  // Either way the second run must insert nothing and the end state must be exactly 20.
  check('seed run 1 inserts 20 or 0 (0 = already seeded)', first.inserted === 20 || first.inserted === 0,
    `inserted ${first.inserted}`);
  check('re-running seed inserts 0 (idempotent)', second.inserted === 0, `inserted ${second.inserted}`);

  const handle = createDb(config.databaseUrl);
  try {
    const sources = await handle.db.execute<{ source: string; n: string }>(
      sql`SELECT source, count(*)::text AS n FROM documents GROUP BY source ORDER BY source`,
    );
    const spread = sources.rows.map((r) => `${r.source}=${r.n}`).join(' ');
    check('documents span all three sources', sources.rows.length === 3, spread);

    // documents is append-only at the storage layer, not by convention.
    await expectRejection(
      'UPDATE on documents rejected',
      () => handle.db.execute(sql`UPDATE documents SET title = 'x'`),
      /append-only/i,
    );
    await expectRejection(
      'DELETE on documents rejected',
      () => handle.db.execute(sql`DELETE FROM documents`),
      /append-only/i,
    );
    await expectRejection(
      'TRUNCATE CASCADE on documents rejected',
      () => handle.db.execute(sql`TRUNCATE documents CASCADE`),
      /append-only/i,
    );
  } finally {
    await handle.close();
  }

  section('3. lib/net.ts (F-04) — real HTTP against a local server');

  // A real socket, so this exercises the actual fetch path rather than a fake.
  let hits = 0;
  const server = createServer((req, res) => {
    hits += 1;
    if (req.url === '/flaky' && hits < 3) {
      res.writeHead(503).end('try again');
      return;
    }
    if (req.url === '/nope') {
      res.writeHead(404).end('gone');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;

  try {
    const net = createNetClient();

    const ok = await net.request(`${base}/ok`, { method: 'GET' });
    check('200 returns a Response', ok.status === 200);

    hits = 0;
    const recovered = await net.request(`${base}/flaky`, { method: 'GET' });
    check('retries through two 503s then succeeds', recovered.status === 200, `${hits} attempts`);

    hits = 0;
    const notFound = await net.request(`${base}/nope`, { method: 'GET' });
    check('404 is NOT retried', notFound.status === 404 && hits === 1, `${hits} attempt(s)`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  section('4. lib/llm.ts + lib/budget.ts (F-05) — guards, no API call');

  await expectRejection(
    'Opus model rejected by the whitelist',
    async () => assertAllowedModel('claude-opus-5'),
    /claude-opus-5|not.*allowed|model/i,
  );
  await expectRejection(
    'unknown future model rejected too (whitelist, not blocklist)',
    async () => assertAllowedModel('claude-opus-9-turbo'),
    /claude-opus-9|not.*allowed|model/i,
  );
  check('haiku 4.5 accepted', (() => { try { assertAllowedModel('claude-haiku-4-5'); return true; } catch { return false; } })());

  // Batch-discounted Haiku: $0.50 per 1M input. 1M input tokens => exactly $0.50.
  const haikuCost = computeCostUsd('claude-haiku-4-5', {
    input_tokens: 1_000_000,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  });
  check('1M Haiku input tokens costs $0.50', Math.abs(haikuCost - 0.5) < 1e-9, `$${haikuCost}`);
  check('Sonnet 5 priced at standard $3/$15, not the expiring intro rate',
    RATES['claude-sonnet-5'].inputPerMillionUsd === 3 && RATES['claude-sonnet-5'].outputPerMillionUsd === 15);

  const under = evaluateBudget({ trailingSpendUsd: 10, pendingEstimateUsd: 1, ceilingUsd: 70 });
  check('budget allows a call under the ceiling', under.withinBudget === true,
    `projected $${under.projectedUsd}`);

  try {
    assertBudget({ trailingSpendUsd: 69.9, pendingEstimateUsd: 5, ceilingUsd: 70 });
    check('budget refuses a call that would breach the ceiling', false, 'expected BudgetExceededError');
  } catch (error) {
    check('budget refuses a call that would breach the ceiling', error instanceof BudgetExceededError);
  }

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  const message = error instanceof AppError ? `${error.code}: ${error.message}` : String(error);
  console.error(`\nSMOKE TEST ABORTED — ${message}`);
  process.exitCode = 1;
});
