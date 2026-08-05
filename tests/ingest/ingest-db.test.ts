// The half of SPEC I-05 that only a real database can prove: that dedup is the
// `(source, source_id)` unique constraint rather than the orchestrator's own bookkeeping,
// that the `runs` row actually lands with counts/duration/errors, and that the new
// `source_cursors` table round-trips an opaque cursor verbatim while staying mutable —
// without weakening `documents`'s append-only triggers.
//
// Provisions its own scratch database (see tests/db/schema.test.ts for the rationale;
// provisioning itself lives in tests/db/scratch-database.ts).
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { documents, runs, sourceCursors } from '../../db/schema.js';
import {
  createDrizzleCursorStore,
  createDrizzleDocumentSink,
  createDrizzleIngestRunRecorder,
} from '../../ingest/repo.js';
import { runIngest } from '../../ingest/orchestrator.js';
import type { SourceIngestCounts } from '../../ingest/types.js';
import { AppError, RateLimitError } from '../../lib/errors.js';
import { createFakeAdapter } from '../../sources/fake-adapter.js';
import { createSourceRegistry } from '../../sources/registry.js';
import { makeDocument } from './fakes.js';
import {
  setupScratchDatabase,
  teardownScratchDatabase,
  type ScratchDatabase,
} from '../db/scratch-database.js';

let scratch: ScratchDatabase;

beforeAll(async () => {
  scratch = await setupScratchDatabase('ingest_test');
}, 30_000);

afterAll(async () => {
  await teardownScratchDatabase(scratch);
}, 30_000);

beforeEach(async () => {
  // `documents` is append-only, so a plain DELETE is refused by the 0002 trigger and TRUNCATE
  // by the 0003 one. Dropping and re-creating the whole scratch database per test would cost
  // a migration run each time; instead every test uses its own `sourceId` prefix and asserts
  // against that prefix, and only the mutable tables are cleared here.
  await scratch.target.db.delete(sourceCursors);
  await scratch.target.db.delete(runs);
});

function deps() {
  return {
    documents: createDrizzleDocumentSink(scratch.target.db),
    cursors: createDrizzleCursorStore(scratch.target.db),
    runs: createDrizzleIngestRunRecorder(scratch.target.db),
  };
}

async function countDocuments(prefix: string): Promise<number> {
  const [row] = await scratch.target.db
    .select({ total: sql<string>`count(*)` })
    .from(documents)
    .where(sql`${documents.sourceId} like ${`${prefix}%`}`);
  return Number(row?.total ?? 0);
}

describe('criterion 1 — re-running immediately inserts zero new rows', () => {
  it('inserts on the first run and nothing at all on an immediate second run', async () => {
    const pages = [
      [makeDocument('hackernews', 'rerun-1'), makeDocument('hackernews', 'rerun-2')],
      [makeDocument('hackernews', 'rerun-3')],
    ];

    const first = await runIngest({
      registry: createSourceRegistry([createFakeAdapter({ source: 'hackernews', pages })]),
      ...deps(),
    });
    const afterFirst = await countDocuments('rerun-');

    const second = await runIngest({
      registry: createSourceRegistry([createFakeAdapter({ source: 'hackernews', pages })]),
      ...deps(),
    });
    const afterSecond = await countDocuments('rerun-');

    expect(first.totals.inserted).toBe(3);
    expect(afterFirst).toBe(3);
    // Zero new rows, which is the criterion. The second run resumed from the persisted
    // cursor rather than replaying every page — so it re-offered only the last page's
    // document, and the unique constraint absorbed that.
    expect(second.totals.inserted).toBe(0);
    expect(second.totals.fetched).toBe(second.totals.duplicates);
    expect(afterSecond).toBe(3);
    expect(second.status).toBe('COMPLETE');
  });

  it('inserts zero even when the whole history is replayed from scratch', async () => {
    // The stronger form of the same criterion, with cursor persistence taken out of the
    // picture: every document is offered a second time and the constraint — not the
    // orchestrator's bookkeeping, and not a read-then-write check that would race — is what
    // makes the second attempt a no-op.
    const pages = [
      [makeDocument('hackernews', 'replay-1'), makeDocument('hackernews', 'replay-2')],
      [makeDocument('hackernews', 'replay-3')],
    ];
    const build = (): ReturnType<typeof createSourceRegistry> =>
      createSourceRegistry([createFakeAdapter({ source: 'hackernews', pages })]);

    const first = await runIngest({ registry: build(), ...deps() });
    await scratch.target.db.delete(sourceCursors);
    const second = await runIngest({ registry: build(), ...deps() });

    expect(first.totals.inserted).toBe(3);
    expect(second.totals.fetched).toBe(3);
    expect(second.totals.inserted).toBe(0);
    expect(second.totals.duplicates).toBe(3);
    expect(await countDocuments('replay-')).toBe(3);
  });

  it('deduplicates two identical (source, source_id) documents inside a single insert', async () => {
    // A page can legitimately carry the same item twice (Hacker News merges results across
    // several configured queries). `ON CONFLICT DO NOTHING` absorbs an in-statement duplicate
    // rather than raising, which is why the sink needs no pre-pass of its own.
    const duplicate = makeDocument('hackernews', 'in-batch-dupe');
    const inserted = await createDrizzleDocumentSink(scratch.target.db).insert([
      duplicate,
      { ...duplicate, title: 'a different title, same identity' },
    ]);

    expect(inserted).toBe(1);
    expect(await countDocuments('in-batch-dupe')).toBe(1);
  });

  it('inserts correctly across more than one batch', async () => {
    const sink = createDrizzleDocumentSink(scratch.target.db, 2);
    const docs = [
      makeDocument('appstore', 'batch-1'),
      makeDocument('appstore', 'batch-2'),
      makeDocument('appstore', 'batch-3'),
      makeDocument('appstore', 'batch-4'),
      makeDocument('appstore', 'batch-5'),
    ];

    expect(await sink.insert(docs)).toBe(5);
    expect(await countDocuments('batch-')).toBe(5);
    // A partially-overlapping second offer counts only what was genuinely new.
    expect(await sink.insert([...docs, makeDocument('appstore', 'batch-6')])).toBe(1);
  });

  it('stores every column the adapter produced, unchanged', async () => {
    const document = makeDocument('reddit', 'columns-check');
    await createDrizzleDocumentSink(scratch.target.db).insert([document]);

    const [row] = await scratch.target.db
      .select()
      .from(documents)
      .where(eq(documents.sourceId, 'columns-check'));

    expect(row?.source).toBe('reddit');
    expect(row?.url).toBe(document.url);
    expect(row?.authorHandle).toBe(document.authorHandle);
    expect(row?.title).toBe(document.title);
    expect(row?.body).toBe(document.body);
    expect(row?.createdAt).toEqual(document.createdAt);
    expect(row?.engagement).toEqual(document.engagement);
    expect(row?.raw).toEqual(document.raw);
    expect(row?.ingestedAt).toBeInstanceOf(Date);
  });
});

describe('criterion 3 — every run writes a runs row', () => {
  it('writes stage, status, per-source counts, duration and finishedAt', async () => {
    const registry = createSourceRegistry(
      [
        createFakeAdapter({
          source: 'hackernews',
          pages: [[makeDocument('hackernews', 'runrow-1')]],
        }),
        createFakeAdapter({ source: 'appstore', pages: [[makeDocument('appstore', 'runrow-2')]] }),
      ],
      [{ source: 'reddit', reason: 'No Reddit credentials configured' }],
    );

    const report = await runIngest({ registry, ...deps() });

    const [row] = await scratch.target.db.select().from(runs).where(eq(runs.id, report.runId));
    expect(row?.stage).toBe('ingest');
    expect(row?.status).toBe('COMPLETE');
    expect(row?.startedAt).toBeInstanceOf(Date);
    expect(row?.finishedAt).toBeInstanceOf(Date);
    expect(row?.errors).toEqual([]);

    const counts = row?.counts as {
      bySource: Record<string, SourceIngestCounts>;
      totals: { fetched: number; inserted: number; duplicates: number };
      durationMs: number;
    };
    expect(Object.keys(counts.bySource).sort()).toEqual(['appstore', 'hackernews', 'reddit']);
    expect(counts.bySource.hackernews?.inserted).toBe(1);
    expect(counts.bySource.appstore?.inserted).toBe(1);
    expect(counts.bySource.reddit?.status).toBe('skipped');
    expect(counts.totals).toEqual({ fetched: 2, inserted: 2, duplicates: 0 });
    expect(typeof counts.durationMs).toBe('number');
  });

  it('records PARTIAL and the failing source’s error when one adapter throws (criterion 2)', async () => {
    const registry = createSourceRegistry([
      createFakeAdapter({
        source: 'hackernews',
        fetchError: new RateLimitError('Hacker News: retries exhausted on 429'),
      }),
      createFakeAdapter({ source: 'appstore', pages: [[makeDocument('appstore', 'survivor')]] }),
    ]);

    const report = await runIngest({ registry, ...deps() });

    const [row] = await scratch.target.db.select().from(runs).where(eq(runs.id, report.runId));
    expect(row?.status).toBe('PARTIAL');
    const errors = row?.errors as { source: string; code: string; message: string }[];
    expect(errors).toHaveLength(1);
    expect(errors[0]?.source).toBe('hackernews');
    expect(errors[0]?.code).toBe('RATE_LIMIT_ERROR');
    // Round-tripped through jsonb with the message intact — a raw Error would have stored `{}`.
    expect(errors[0]?.message).toContain('retries exhausted');
    // The other adapter still wrote its document.
    expect(await countDocuments('survivor')).toBe(1);
  });

  it('a run row exists from the moment the run starts, not only once it finishes', async () => {
    // What makes "a run that crashes without writing its row" impossible: the row is inserted
    // up front, so even a hard crash mid-run leaves a `running` row behind.
    const recorder = createDrizzleIngestRunRecorder(scratch.target.db);
    const runId = await recorder.start('ingest');

    const [row] = await scratch.target.db.select().from(runs).where(eq(runs.id, runId));
    expect(row?.status).toBe('running');
    expect(row?.finishedAt).toBeNull();
  });

  it('fails loudly rather than silently when finish() matches no row', async () => {
    const recorder = createDrizzleIngestRunRecorder(scratch.target.db);
    const missing = '00000000-0000-4000-8000-000000000000';

    await expect(
      recorder.finish(missing, {
        status: 'COMPLETE',
        finishedAt: new Date(),
        counts: {},
        errors: [],
      }),
    ).rejects.toThrow(AppError);
  });
});

describe('cursor persistence (blocker B-08)', () => {
  it('round-trips an opaque cursor verbatim, whatever is in it', async () => {
    const store = createDrizzleCursorStore(scratch.target.db);
    // Shaped like the App Store adapter's real cursor, plus characters a naive encoder would
    // mangle — the orchestrator and this table only ever store and replay, never parse.
    const opaque = '{"284910350:us":"2026-08-05T12:00:00-07:00","weird":"a,b\\n\\"c\\""}';

    expect(await store.get('appstore')).toBeUndefined();
    await store.set('appstore', opaque);
    expect(await store.get('appstore')).toBe(opaque);
  });

  it('advances an existing cursor in place — the table is mutable by design', async () => {
    const store = createDrizzleCursorStore(scratch.target.db);
    await store.set('hackernews', 'confirmed-through-1754000000');
    await store.set('hackernews', 'confirmed-through-1754003600');

    expect(await store.get('hackernews')).toBe('confirmed-through-1754003600');
    const rows = await scratch.target.db
      .select()
      .from(sourceCursors)
      .where(eq(sourceCursors.source, 'hackernews'));
    // One row per source, not an append-only history: a second row would make "the" cursor
    // ambiguous.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.updatedAt).toBeInstanceOf(Date);
  });

  it('keeps each source’s cursor separate', async () => {
    const store = createDrizzleCursorStore(scratch.target.db);
    await store.set('hackernews', 'hn-cursor');
    await store.set('appstore', 'appstore-cursor');

    expect(await store.get('hackernews')).toBe('hn-cursor');
    expect(await store.get('appstore')).toBe('appstore-cursor');
    expect(await store.get('reddit')).toBeUndefined();
  });

  it('persists across runs: a second run resumes from where the first stopped', async () => {
    const pages = [
      [makeDocument('hackernews', 'resume-1')],
      [makeDocument('hackernews', 'resume-2')],
    ];
    const first = createFakeAdapter({ source: 'hackernews', pages });

    await runIngest({ registry: createSourceRegistry([first]), ...deps(), maxPagesPerRun: 1 });

    // Page 1 only, and its cursor is now on disk.
    expect(await countDocuments('resume-')).toBe(1);
    const [stored] = await scratch.target.db
      .select()
      .from(sourceCursors)
      .where(eq(sourceCursors.source, 'hackernews'));
    expect(stored?.cursor).toBe('1');

    // A fresh adapter instance, exactly as a separate process would build: it resumes only
    // because the cursor came back out of the database.
    const second = createFakeAdapter({ source: 'hackernews', pages });
    await runIngest({ registry: createSourceRegistry([second]), ...deps(), maxPagesPerRun: 1 });

    expect(await countDocuments('resume-')).toBe(2);
  });

  it('leaves documents’ append-only triggers intact — source_cursors being mutable is not a loosening', async () => {
    await createDrizzleDocumentSink(scratch.target.db).insert([
      makeDocument('hackernews', 'still-append-only'),
    ]);

    await expect(
      scratch.target.db
        .update(documents)
        .set({ title: 'mutated' })
        .where(eq(documents.sourceId, 'still-append-only')),
    ).rejects.toThrow(/append-only/);

    await expect(
      scratch.target.db.delete(documents).where(eq(documents.sourceId, 'still-append-only')),
    ).rejects.toThrow(/append-only/);
  });
});
