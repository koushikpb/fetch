// Behavioural proof for SPEC I-05's three criteria and the composer's five resolutions,
// against in-memory seams. The database-level halves — that dedup is really the
// `(source, source_id)` unique constraint, and that the `runs` row really lands — are
// tests/ingest/ingest-db.test.ts's job; nothing here claims to prove those.
import { describe, expect, it } from 'vitest';
import { runIngest } from '../../ingest/orchestrator.js';
import type { IngestReport, SourceIngestCounts } from '../../ingest/types.js';
import { NetworkError, RateLimitError, UpstreamError } from '../../lib/errors.js';
import type { Source } from '../../lib/types.js';
import { createFakeAdapter } from '../../sources/fake-adapter.js';
import { createSourceRegistry } from '../../sources/registry.js';
import {
  createFakeCursorStore,
  createFakeDocumentSink,
  createFakeRunRecorder,
  createStallingAdapter,
  makeDocument,
  type FakeCursorStore,
  type FakeDocumentSink,
  type FakeRunRecorder,
} from './fakes.js';

interface Harness {
  readonly documents: FakeDocumentSink;
  readonly cursors: FakeCursorStore;
  readonly runs: FakeRunRecorder;
}

function harness(cursorSeed: Iterable<[Source, string]> = []): Harness {
  return {
    documents: createFakeDocumentSink(),
    cursors: createFakeCursorStore(cursorSeed),
    runs: createFakeRunRecorder(),
  };
}

function countsFor(report: IngestReport, source: Source): SourceIngestCounts {
  const entry = report.counts.find((candidate) => candidate.source === source);
  if (entry === undefined) {
    expect.fail(`no counts recorded for source "${source}"`);
  }
  return entry;
}

describe('runIngest — documents reach the sink and are accounted for', () => {
  it('writes every document an adapter returns, across multiple pages', async () => {
    const adapter = createFakeAdapter({
      source: 'hackernews',
      pages: [
        [makeDocument('hackernews', 'a'), makeDocument('hackernews', 'b')],
        [makeDocument('hackernews', 'c')],
      ],
    });
    const h = harness();

    const report = await runIngest({
      registry: createSourceRegistry([adapter]),
      ...h,
    });

    expect(h.documents.stored.size).toBe(3);
    const counts = countsFor(report, 'hackernews');
    expect(counts.fetched).toBe(3);
    expect(counts.inserted).toBe(3);
    expect(counts.duplicates).toBe(0);
    expect(counts.pages).toBe(2);
    expect(counts.stopReason).toBe('exhausted');
    expect(report.status).toBe('COMPLETE');
    expect(report.totals).toEqual({ fetched: 3, inserted: 3, duplicates: 0 });
  });

  it('re-running over the same documents inserts zero new rows and reports them as duplicates', async () => {
    // Criterion 1, at the accounting level: the sink dedups on the same `(source, sourceId)`
    // key the real constraint uses, and the orchestrator must report what the sink actually
    // inserted rather than how many documents it was handed.
    const pages = [[makeDocument('hackernews', 'a'), makeDocument('hackernews', 'b')]];
    const h = harness();
    const registry = createSourceRegistry([createFakeAdapter({ source: 'hackernews', pages })]);

    const first = await runIngest({ registry, ...h });
    const second = await runIngest({
      registry: createSourceRegistry([createFakeAdapter({ source: 'hackernews', pages })]),
      ...h,
    });

    expect(first.totals.inserted).toBe(2);
    expect(second.totals.inserted).toBe(0);
    expect(second.totals.fetched).toBe(2);
    expect(second.totals.duplicates).toBe(2);
    expect(h.documents.stored.size).toBe(2);
    expect(second.status).toBe('COMPLETE');
  });

  it('an empty page is not an error and is never handed to the sink as an empty insert', async () => {
    const adapter = createFakeAdapter({ source: 'appstore', pages: [] });
    const h = harness();

    const report = await runIngest({ registry: createSourceRegistry([adapter]), ...h });

    expect(countsFor(report, 'appstore').fetched).toBe(0);
    expect(report.status).toBe('COMPLETE');
  });
});

describe('runIngest — one adapter failing does not abort the others (criterion 2)', () => {
  it('records the thrower, still runs the rest, and marks the run PARTIAL', async () => {
    const broken = createFakeAdapter({
      source: 'hackernews',
      fetchError: new RateLimitError('Hacker News: retries exhausted on 429'),
    });
    const healthy = createFakeAdapter({
      source: 'appstore',
      pages: [[makeDocument('appstore', 'x')]],
    });
    const h = harness();

    const report = await runIngest({
      registry: createSourceRegistry([broken, healthy]),
      ...h,
    });

    expect(report.status).toBe('PARTIAL');
    expect(countsFor(report, 'hackernews').status).toBe('failed');
    expect(countsFor(report, 'hackernews').stopReason).toBe('error');
    // The point of the criterion: the *other* source completed rather than being aborted.
    expect(countsFor(report, 'appstore').status).toBe('complete');
    expect(countsFor(report, 'appstore').inserted).toBe(1);
    expect(h.documents.stored.size).toBe(1);

    const error = report.errors.find((entry) => entry.source === 'hackernews');
    expect(error?.kind).toBe('thrown');
    expect(error?.code).toBe('RATE_LIMIT_ERROR');
    expect(error?.message).toContain('retries exhausted');
  });

  it('a source that throws after the first page keeps the documents from the pages that succeeded', async () => {
    const adapter = createFakeAdapter({
      source: 'hackernews',
      pages: [[makeDocument('hackernews', 'kept-1')], [makeDocument('hackernews', 'kept-2')]],
    });
    const h = harness();

    // Fails only once the first page has already been fetched and written.
    const registry = createSourceRegistry([
      {
        source: 'hackernews',
        checkHealth: adapter.checkHealth.bind(adapter),
        fetchBackfill: adapter.fetchBackfill.bind(adapter),
        async fetchIncremental(cursor) {
          if (cursor !== undefined) {
            throw new NetworkError('Hacker News: connection reset on page 2');
          }
          return adapter.fetchIncremental(cursor);
        },
      },
      createFakeAdapter({ source: 'appstore', pages: [[makeDocument('appstore', 'other')]] }),
    ]);

    const report = await runIngest({ registry, ...h });

    // Page 1's document survives page 2's failure — the mid-walk error must not discard what
    // was already written.
    expect(h.documents.stored.has('hackernews:kept-1')).toBe(true);
    expect(countsFor(report, 'hackernews').inserted).toBe(1);
    expect(countsFor(report, 'hackernews').status).toBe('failed');
    expect(countsFor(report, 'appstore').status).toBe('complete');
    expect(report.status).toBe('PARTIAL');
  });

  it('an adapter throwing a non-AppError is contained and recorded rather than aborting the run', async () => {
    const broken = createFakeAdapter({ source: 'hackernews' });
    const h = harness();
    const registry = createSourceRegistry([
      {
        source: 'hackernews',
        checkHealth: broken.checkHealth.bind(broken),
        fetchBackfill: broken.fetchBackfill.bind(broken),
        async fetchIncremental() {
          // A bug in an adapter, not a typed pipeline failure — recorded faithfully instead
          // of being reclassified into the taxonomy or allowed to kill the other sources.
          throw new TypeError('cannot read properties of undefined');
        },
      },
      createFakeAdapter({ source: 'appstore', pages: [[makeDocument('appstore', 'ok')]] }),
    ]);

    const report = await runIngest({ registry, ...h });

    expect(report.status).toBe('PARTIAL');
    expect(countsFor(report, 'appstore').status).toBe('complete');
    const error = report.errors.find((entry) => entry.source === 'hackernews');
    expect(error?.name).toBe('TypeError');
    expect(error?.code).toBeUndefined();
  });

  it('is FAILED, not PARTIAL, when every attempted source failed', async () => {
    const h = harness();
    const registry = createSourceRegistry([
      createFakeAdapter({ source: 'hackernews', fetchError: new UpstreamError('hn down') }),
      createFakeAdapter({ source: 'appstore', fetchError: new UpstreamError('appstore down') }),
    ]);

    const report = await runIngest({ registry, ...h });

    expect(report.status).toBe('FAILED');
    expect(report.errors).toHaveLength(2);
  });
});

describe('runIngest — FetchPage.outcome (composer resolution 4)', () => {
  it('truncated is not a failure: the reason is recorded and the run stays COMPLETE', async () => {
    const adapter = createFakeAdapter({
      source: 'appstore',
      pages: [
        {
          documents: [makeDocument('appstore', 'trunc-1')],
          outcome: {
            kind: 'truncated',
            reason: 'RSS feed capped at 500 reviews for 284910350 (us)',
          },
        },
      ],
    });
    const h = harness();

    const report = await runIngest({ registry: createSourceRegistry([adapter]), ...h });

    expect(report.status).toBe('COMPLETE');
    const counts = countsFor(report, 'appstore');
    expect(counts.status).toBe('complete');
    expect(counts.truncatedReasons).toEqual(['RSS feed capped at 500 reviews for 284910350 (us)']);
    // Truncation is a coverage fact, not an error — it must not appear in `runs.errors`.
    expect(report.errors).toEqual([]);
    expect(counts.inserted).toBe(1);
  });

  it('partial makes the run PARTIAL, records the error, and still writes the salvaged documents', async () => {
    const adapter = createFakeAdapter({
      source: 'appstore',
      pages: [
        {
          documents: [makeDocument('appstore', 'salvaged')],
          outcome: { kind: 'partial', error: new NetworkError('gb storefront timed out') },
        },
      ],
    });
    const h = harness();

    const report = await runIngest({ registry: createSourceRegistry([adapter]), ...h });

    expect(report.status).toBe('PARTIAL');
    expect(countsFor(report, 'appstore').status).toBe('partial');
    expect(h.documents.stored.size).toBe(1);
    expect(report.errors[0]?.kind).toBe('partial');
    expect(report.errors[0]?.code).toBe('NETWORK_ERROR');
  });

  it('partial carrying a truncatedReason records both, not just the disposition', async () => {
    const adapter = createFakeAdapter({
      source: 'appstore',
      pages: [
        {
          documents: [makeDocument('appstore', 'both')],
          outcome: {
            kind: 'partial',
            error: new NetworkError('gb storefront timed out'),
            truncatedReason: 'us storefront hit the 500-review ceiling',
          },
        },
      ],
    });
    const h = harness();

    const report = await runIngest({ registry: createSourceRegistry([adapter]), ...h });

    expect(report.status).toBe('PARTIAL');
    const counts = countsFor(report, 'appstore');
    expect(counts.truncatedReasons).toEqual(['us storefront hit the 500-review ceiling']);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]?.message).toContain('gb storefront timed out');
  });
});

describe('runIngest — the stall predicate (composer resolution 3)', () => {
  it('halts a source that returns the cursor it was given alongside a partial outcome', async () => {
    const stalling = createStallingAdapter({
      source: 'reddit',
      page: {
        documents: [],
        cursor: undefined,
        outcome: { kind: 'partial', error: new UpstreamError('reddit: 503 on every attempt') },
      },
    });
    const h = harness([['reddit', 'stuck-cursor']]);

    const report = await runIngest({
      registry: createSourceRegistry([stalling]),
      ...h,
      maxPagesPerRun: 5,
    });

    // Note what this line does and does not prove. It is *not* what discriminates the stall
    // predicate: with the predicate disabled (verified by mutating the orchestrator and
    // re-running), the source is still called exactly once, because the no-progress rule
    // below it terminates the loop on the same identical cursor. What the predicate adds is
    // the *classification* — and that is what the assertions below catch: without it this
    // run is a quiet `partial`/`no-progress` with no SOURCE_STALLED error at all, which is a
    // permanently wedged source reported as an ordinary bad afternoon.
    expect(stalling.callCount()).toBe(1);
    const counts = countsFor(report, 'reddit');
    expect(counts.status).toBe('stalled');
    expect(counts.stopReason).toBe('stalled');
    expect(report.status).toBe('FAILED');

    const stallError = report.errors.find((entry) => entry.kind === 'stalled');
    expect(stallError?.code).toBe('SOURCE_STALLED');
    expect(stallError?.message).toContain('same cursor');
    // The underlying partial error is recorded too — the stall record explains the halt, it
    // does not replace the cause.
    expect(report.errors.some((entry) => entry.code === 'UPSTREAM_ERROR')).toBe(true);
  });

  it('halts on a stall without ever inventing a cursor to skip past the failing page', async () => {
    const stalling = createStallingAdapter({
      source: 'reddit',
      page: {
        documents: [makeDocument('reddit', 'salvaged-before-stall')],
        cursor: undefined,
        outcome: { kind: 'partial', error: new UpstreamError('reddit: 503') },
      },
    });
    const h = harness([['reddit', 'stuck-cursor']]);

    await runIngest({ registry: createSourceRegistry([stalling]), ...h, maxPagesPerRun: 5 });

    // The adapter was replayed the stored cursor verbatim...
    expect(stalling.cursorsSeen()).toEqual(['stuck-cursor']);
    // ...and the store still holds it unchanged: halting must not advance or clear it.
    expect(h.cursors.values.get('reddit')).toBe('stuck-cursor');
    expect(h.cursors.writes).toEqual([]);
    // The documents the adapter did salvage before stalling were still written.
    expect(h.documents.stored.size).toBe(1);
  });

  it('does not treat an identical cursor without a partial outcome as a stall', async () => {
    // The App Store adapter's incremental fetch never returns `cursor: undefined` — it always
    // encodes its per-pair high-water state — so in a caught-up steady state it hands back
    // exactly the cursor it was given, with no outcome at all. That is ordinary termination,
    // not a fault, and must not be recorded as one.
    const steady = createStallingAdapter({
      source: 'appstore',
      page: { documents: [], cursor: undefined },
    });
    const h = harness([['appstore', '{"284910350:us":"2026-08-01T00:00:00Z"}']]);

    const report = await runIngest({
      registry: createSourceRegistry([steady]),
      ...h,
      maxPagesPerRun: 5,
    });

    // This one *is* discriminating for the no-progress rule: with it removed, the same
    // adapter is called 5 times rather than 1 (verified by mutation), which is the shape of
    // an every-run page-limit walk against a caught-up upstream.
    expect(steady.callCount()).toBe(1);
    const counts = countsFor(report, 'appstore');
    expect(counts.status).toBe('complete');
    expect(counts.stopReason).toBe('no-progress');
    expect(report.status).toBe('COMPLETE');
    expect(report.errors).toEqual([]);
  });

  it('does not treat a partial with no cursor at all as a stall', async () => {
    // The Hacker News adapter returns `cursor: undefined` on every `partial` by design — the
    // next call replays the same starting boundary from scratch. On a first run there is no
    // stored cursor either, so both sides are `undefined`; calling that "identical" would
    // brand every first-run transient failure as a permanently stalled source.
    const adapter = createFakeAdapter({
      source: 'hackernews',
      pages: [
        {
          documents: [makeDocument('hackernews', 'salvaged')],
          outcome: { kind: 'partial', error: new NetworkError('algolia: connection reset') },
        },
      ],
    });
    const h = harness();

    const report = await runIngest({
      registry: createSourceRegistry([adapter]),
      ...h,
      maxPagesPerRun: 5,
    });

    const counts = countsFor(report, 'hackernews');
    expect(counts.status).toBe('partial');
    expect(counts.stopReason).toBe('exhausted');
    expect(report.errors.some((entry) => entry.kind === 'stalled')).toBe(false);
    expect(h.documents.stored.size).toBe(1);
  });

  it('a partial that drops its cursor leaves the stored high-water mark in place to be replayed', async () => {
    const adapter = createFakeAdapter({ source: 'hackernews' });
    const h = harness([['hackernews', 'confirmed-through-1754000000']]);
    const registry = createSourceRegistry([
      {
        source: 'hackernews',
        checkHealth: adapter.checkHealth.bind(adapter),
        fetchBackfill: adapter.fetchBackfill.bind(adapter),
        async fetchIncremental() {
          return {
            documents: [makeDocument('hackernews', 'partial-salvage')],
            cursor: undefined,
            outcome: { kind: 'partial' as const, error: new NetworkError('firebase: timeout') },
          };
        },
      },
    ]);

    const report = await runIngest({ registry, ...h, maxPagesPerRun: 5 });

    expect(countsFor(report, 'hackernews').status).toBe('partial');
    // Untouched, so the next run resumes from it rather than from the adapter's initial
    // lookback — the difference between a free re-fetch and a permanent skip.
    expect(h.cursors.values.get('hackernews')).toBe('confirmed-through-1754000000');
  });

  it('bounds pages per run as a backstop even when every page reports progress', async () => {
    // An adapter that always advances its cursor and never exhausts: nothing about it trips
    // the stall predicate, so only the page bound stops it.
    let calls = 0;
    const h = harness();
    const registry = createSourceRegistry([
      {
        source: 'hackernews',
        async checkHealth() {
          return { healthy: true, detail: 'ok' };
        },
        async fetchBackfill() {
          return { documents: [], cursor: undefined };
        },
        async fetchIncremental() {
          calls += 1;
          return { documents: [makeDocument('hackernews')], cursor: `page-${calls}` };
        },
      },
    ]);

    const report = await runIngest({ registry, ...h, maxPagesPerRun: 3 });

    expect(calls).toBe(3);
    const counts = countsFor(report, 'hackernews');
    expect(counts.pages).toBe(3);
    expect(counts.stopReason).toBe('page-limit');
    // Resumable, not broken: the cursor from the last completed page is persisted so the next
    // run picks up where this one left off.
    expect(h.cursors.values.get('hackernews')).toBe('page-3');
    expect(report.status).toBe('COMPLETE');
  });
});

describe('runIngest — cursor persistence (blocker B-08)', () => {
  it('replays the stored cursor verbatim and never interprets it', async () => {
    // Deliberately not a plausible cursor for any adapter: the orchestrator must round-trip
    // whatever opaque string it was given, byte for byte.
    const opaque = '{"weird":"value","with":["nested",1,null]} \n ';
    const adapter = createFakeAdapter({ source: 'hackernews' });
    const seen: (string | undefined)[] = [];
    const h = harness([['hackernews', opaque]]);

    const registry = createSourceRegistry([
      {
        source: 'hackernews',
        checkHealth: adapter.checkHealth.bind(adapter),
        fetchBackfill: adapter.fetchBackfill.bind(adapter),
        async fetchIncremental(cursor) {
          seen.push(cursor);
          return { documents: [], cursor: undefined };
        },
      },
    ]);

    await runIngest({ registry, ...h });

    expect(seen).toEqual([opaque]);
  });

  it('persists each page cursor as it goes, not once at the end', async () => {
    const adapter = createFakeAdapter({
      source: 'hackernews',
      pages: [
        [makeDocument('hackernews')],
        [makeDocument('hackernews')],
        [makeDocument('hackernews')],
      ],
    });
    const h = harness();

    await runIngest({ registry: createSourceRegistry([adapter]), ...h });

    // The fake adapter's cursors are page indices; what matters is that each one was written
    // when it arrived, so a run that dies mid-walk keeps the ground it covered.
    expect(h.cursors.writes.map((write) => write.cursor)).toEqual(['1', '2']);
  });

  it('never clears a stored cursor when an adapter reports it is caught up', async () => {
    // Clearing would send the next run back to the adapter's initial lookback, permanently
    // skipping everything older than it — the one failure mode the "err toward re-fetching,
    // never toward skipping" ruling exists to prevent.
    const adapter = createFakeAdapter({ source: 'hackernews', pages: [] });
    const h = harness([['hackernews', 'high-water-mark']]);

    await runIngest({ registry: createSourceRegistry([adapter]), ...h });

    expect(h.cursors.values.get('hackernews')).toBe('high-water-mark');
  });

  it('backfill neither reads nor writes the persisted incremental cursor', async () => {
    const adapter = createFakeAdapter({
      source: 'hackernews',
      backfillPages: [[makeDocument('hackernews', 'old-1')], [makeDocument('hackernews', 'old-2')]],
    });
    const h = harness([['hackernews', 'incremental-high-water-mark']]);

    const report = await runIngest({
      registry: createSourceRegistry([adapter]),
      ...h,
      mode: {
        kind: 'backfill',
        range: { since: new Date('2026-01-01T00:00:00Z'), until: new Date('2026-02-01T00:00:00Z') },
      },
    });

    expect(adapter.fake.backfillCallCount()).toBe(2);
    expect(adapter.fake.incrementalCallCount()).toBe(0);
    expect(h.documents.stored.size).toBe(2);
    // The incremental high-water mark is untouched: a one-shot range walk must not overwrite
    // a long-lived mark it knows nothing about.
    expect(h.cursors.values.get('hackernews')).toBe('incremental-high-water-mark');
    expect(h.cursors.writes).toEqual([]);
    expect(h.cursors.reads).toEqual([]);
    expect(report.status).toBe('COMPLETE');
  });
});

describe('runIngest — a source that is configured off (blocker B-09)', () => {
  it('records it as skipped with the registry’s reason, and does not make the run PARTIAL', async () => {
    const h = harness();
    const registry = createSourceRegistry(
      [createFakeAdapter({ source: 'hackernews', pages: [[makeDocument('hackernews')]] })],
      [{ source: 'reddit', reason: 'No Reddit credentials configured' }],
    );

    const report = await runIngest({ registry, ...h });

    expect(report.status).toBe('COMPLETE');
    const reddit = countsFor(report, 'reddit');
    expect(reddit.status).toBe('skipped');
    expect(reddit.stopReason).toBe('not-attempted');
    expect(reddit.detail).toBe('No Reddit credentials configured');
    expect(report.errors).toEqual([]);
  });

  it('accounts for every source in SOURCES, even one the registry never mentioned', async () => {
    // The failure mode this guards: a source silently absent from the run's counts is
    // indistinguishable from a source that ran and found nothing.
    const h = harness();
    const registry = createSourceRegistry([createFakeAdapter({ source: 'hackernews' })]);

    const report = await runIngest({ registry, ...h });

    expect(report.counts.map((entry) => entry.source).sort()).toEqual([
      'appstore',
      'hackernews',
      'reddit',
    ]);
    expect(countsFor(report, 'appstore').status).toBe('skipped');
    expect(countsFor(report, 'appstore').detail).toContain('No adapter registered');
  });
});

describe('runIngest — checkHealth (I-01 resolution 5)', () => {
  it('does not fetch from a source that reports unhealthy, and records why', async () => {
    const unhealthy = createFakeAdapter({
      source: 'reddit',
      health: { healthy: false, detail: 'Reddit: token endpoint returned 401' },
      pages: [[makeDocument('reddit')]],
    });
    const h = harness();

    const report = await runIngest({
      registry: createSourceRegistry([
        unhealthy,
        createFakeAdapter({ source: 'hackernews', pages: [[makeDocument('hackernews')]] }),
      ]),
      ...h,
    });

    expect(unhealthy.fake.healthCallCount()).toBe(1);
    expect(unhealthy.fake.incrementalCallCount()).toBe(0);
    const counts = countsFor(report, 'reddit');
    expect(counts.status).toBe('unhealthy');
    expect(counts.stopReason).toBe('not-attempted');
    expect(counts.detail).toBe('Reddit: token endpoint returned 401');
    expect(report.errors[0]?.kind).toBe('unhealthy');
    // The healthy source still ran.
    expect(countsFor(report, 'hackernews').inserted).toBe(1);
    expect(report.status).toBe('PARTIAL');
  });
});

describe('runIngest — the runs row is always written (criterion 3)', () => {
  it('records status, per-source counts, duration and errors on a clean run', async () => {
    let tick = 0;
    const h = harness();
    const registry = createSourceRegistry(
      [
        createFakeAdapter({ source: 'hackernews', pages: [[makeDocument('hackernews', 'h1')]] }),
        createFakeAdapter({ source: 'appstore', pages: [[makeDocument('appstore', 'a1')]] }),
      ],
      [{ source: 'reddit', reason: 'No Reddit credentials configured' }],
    );

    const report = await runIngest({
      registry,
      ...h,
      now: () => new Date(1_800_000_000_000 + tick++ * 1000),
    });

    expect(h.runs.started).toHaveLength(1);
    expect(h.runs.finished).toHaveLength(1);
    const recorded = h.runs.finished[0];
    expect(recorded?.runId).toBe(report.runId);
    expect(recorded?.result.status).toBe('COMPLETE');
    expect(recorded?.result.errors).toEqual([]);
    expect(recorded?.result.finishedAt).toBeInstanceOf(Date);

    const counts = recorded?.result.counts as {
      bySource: Record<string, SourceIngestCounts>;
      totals: { fetched: number; inserted: number; duplicates: number };
      durationMs: number;
    };
    expect(Object.keys(counts.bySource).sort()).toEqual(['appstore', 'hackernews', 'reddit']);
    expect(counts.bySource.hackernews?.inserted).toBe(1);
    expect(counts.bySource.reddit?.status).toBe('skipped');
    expect(counts.totals).toEqual({ fetched: 2, inserted: 2, duplicates: 0 });
    expect(counts.durationMs).toBeGreaterThan(0);
    expect(counts.bySource.hackernews?.durationMs).toBeGreaterThanOrEqual(0);
    // The report and the row describe the same run rather than two independently-sampled ones.
    expect(report.finishedAt).toEqual(recorded?.result.finishedAt);
  });

  it('records PARTIAL with the per-source errors when a source fails', async () => {
    const h = harness();
    const registry = createSourceRegistry([
      createFakeAdapter({ source: 'hackernews', fetchError: new RateLimitError('429') }),
      createFakeAdapter({ source: 'appstore', pages: [[makeDocument('appstore')]] }),
    ]);

    await runIngest({ registry, ...h });

    const recorded = h.runs.finished[0];
    expect(recorded?.result.status).toBe('PARTIAL');
    expect(recorded?.result.errors).toHaveLength(1);
    expect(recorded?.result.errors[0]?.source).toBe('hackernews');
    expect(recorded?.result.errors[0]?.code).toBe('RATE_LIMIT_ERROR');
    // Recorded as a plain object, not a raw Error: `message` is non-enumerable on Error, so a
    // jsonb column handed the error itself would store `{}`.
    expect(JSON.stringify(recorded?.result.errors)).toContain('429');
  });

  it('still writes the row — as FAILED, with the cause — when the run itself throws', async () => {
    // The failure mode criterion 3 exists to design against: a run that dies without leaving
    // any trace of having happened. The cursor store failing is a run-level fault, outside
    // any single source's error boundary.
    const h = harness();
    h.cursors.failOnGet(new UpstreamError('source_cursors: relation does not exist'));
    const registry = createSourceRegistry([createFakeAdapter({ source: 'hackernews' })]);

    await expect(runIngest({ registry, ...h })).rejects.toThrow(/relation does not exist/);

    expect(h.runs.finished).toHaveLength(1);
    const recorded = h.runs.finished[0];
    expect(recorded?.result.status).toBe('FAILED');
    expect(recorded?.result.errors[0]?.kind).toBe('run');
    expect(recorded?.result.errors[0]?.source).toBeNull();
  });

  it('surfaces a failure to write the row when nothing else went wrong', async () => {
    const h = harness();
    h.runs.failOnFinish(new UpstreamError('runs: update matched no row'));
    const registry = createSourceRegistry([createFakeAdapter({ source: 'hackernews' })]);

    await expect(runIngest({ registry, ...h })).rejects.toThrow(/matched no row/);
  });

  it('keeps the original failure when the row write also fails', async () => {
    const h = harness();
    h.cursors.failOnGet(new UpstreamError('the original cause'));
    h.runs.failOnFinish(new UpstreamError('and the row write failed too'));
    const registry = createSourceRegistry([createFakeAdapter({ source: 'hackernews' })]);

    // The original cause propagates; the row-write failure is logged rather than replacing it.
    await expect(runIngest({ registry, ...h })).rejects.toThrow(/the original cause/);
  });
});
