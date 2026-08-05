// What one scheduled tick does, and — the part that decides whether a retry is correct —
// which run outcomes it converts into a thrown error. These drive the *real* orchestrator
// over fake adapters, so the dispositions asserted here are the ones I-05 actually produces
// rather than ones restated in a stub.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { restrictRegistryToSource, runIngestJob } from '../../jobs/index.js';
import type { IngestJobContext } from '../../jobs/index.js';
import { AppError, RateLimitError } from '../../lib/errors.js';
import type { Source } from '../../lib/types.js';
import { createSourceRegistry, type SourceRegistry } from '../../sources/registry.js';
import type { SourceAdapter } from '../../sources/types.js';
import {
  createFakeAdapter,
  createMemoryCursorStore,
  createMemoryDocumentSink,
  createMemoryRunRecorder,
  makeDocument,
  parseLogLines,
  type FakeAdapter,
} from './fakes.js';

function harnessFor(
  adapters: readonly FakeAdapter[],
  skipped: readonly { source: Source; reason: string }[] = [],
): { context: IngestJobContext } {
  const registry: SourceRegistry = createSourceRegistry(
    adapters as readonly SourceAdapter[],
    skipped,
  );
  return {
    context: {
      registry,
      documents: createMemoryDocumentSink(),
      cursors: createMemoryCursorStore(),
      runs: createMemoryRunRecorder(),
    },
  };
}

function captureLog(): { lines: () => string[]; restore: () => void } {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  });
  return { lines: () => chunks, restore: () => spy.mockRestore() };
}

describe('restrictRegistryToSource', () => {
  it('registers only the target source and explains the absence of the others', () => {
    const full = createSourceRegistry([
      createFakeAdapter({ source: 'hackernews' }),
      createFakeAdapter({ source: 'appstore' }),
    ]);
    const restricted = restrictRegistryToSource(full, 'appstore');
    expect(restricted.list()).toEqual(['appstore']);
    expect(
      restricted
        .skipped()
        .map((entry) => entry.source)
        .sort(),
    ).toEqual(['hackernews', 'reddit']);
    for (const entry of restricted.skipped()) {
      expect(entry.reason).not.toBe('');
    }
  });

  it('forwards the real reason when the target source is the one configured off', () => {
    const full = createSourceRegistry(
      [createFakeAdapter({ source: 'hackernews' })],
      [{ source: 'reddit', reason: 'No Reddit credentials configured' }],
    );
    const restricted = restrictRegistryToSource(full, 'reddit');
    expect(restricted.list()).toEqual([]);
    const reddit = restricted.skipped().find((entry) => entry.source === 'reddit');
    expect(reddit?.reason).toBe('No Reddit credentials configured');
  });
});

describe('runIngestJob', () => {
  let capture: ReturnType<typeof captureLog>;

  beforeEach(() => {
    capture = captureLog();
  });

  afterEach(() => {
    capture.restore();
  });

  it('runs only its own source, leaving the other adapters untouched', async () => {
    const hn = createFakeAdapter({ source: 'hackernews' });
    const appstore = createFakeAdapter({ source: 'appstore' });
    const { context } = harnessFor([hn, appstore]);

    const result = await runIngestJob('hackernews', context);

    expect(result.status).toBe('COMPLETE');
    expect(result.sourceStatus).toBe('complete');
    expect(hn.calls.fetchIncremental).toBe(1);
    // The lock is per source, so a job that quietly ran all three would make it meaningless.
    expect(appstore.calls.fetchIncremental).toBe(0);
    expect(appstore.calls.checkHealth).toBe(0);
  });

  it('throws when the run comes back FAILED, which is how pg-boss is asked to retry', async () => {
    const hn = createFakeAdapter({
      source: 'hackernews',
      fetchIncremental: () => Promise.reject(new RateLimitError('Hacker News: retries exhausted')),
    });
    const { context } = harnessFor([hn]);

    await expect(runIngestJob('hackernews', context)).rejects.toMatchObject({
      code: 'INGEST_RUN_FAILED',
    });
  });

  it('throws when the only source is unhealthy, since nothing usable came back', async () => {
    const hn = createFakeAdapter({
      source: 'hackernews',
      health: { healthy: false, detail: 'Algolia unreachable' },
    });
    const { context } = harnessFor([hn]);

    await expect(runIngestJob('hackernews', context)).rejects.toBeInstanceOf(AppError);
  });

  it('carries the failure detail into the thrown error, so a dead letter entry says why', async () => {
    const hn = createFakeAdapter({
      source: 'hackernews',
      fetchIncremental: () => Promise.reject(new RateLimitError('429 from Algolia')),
    });
    const { context } = harnessFor([hn]);

    const error: unknown = await runIngestJob('hackernews', context).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppError);
    const context_ = (error as AppError).context;
    expect(context_?.source).toBe('hackernews');
    expect(context_?.runId).toBeDefined();
    expect(JSON.stringify(context_?.errors)).toContain('429 from Algolia');
  });

  it('does not throw on PARTIAL — the documents were written and the cursor advanced', async () => {
    const hn = createFakeAdapter({
      source: 'hackernews',
      fetchIncremental: () =>
        Promise.resolve({
          documents: [makeDocument('hackernews', 'salvaged')],
          cursor: undefined,
          outcome: { kind: 'partial' as const, error: new RateLimitError('item 40 of 50') },
        }),
    });
    const { context } = harnessFor([hn]);

    const result = await runIngestJob('hackernews', context);

    expect(result.status).toBe('PARTIAL');
    expect(result.totals.inserted).toBe(1);
    const records = parseLogLines(capture.lines());
    expect(records.some((r) => r.msg === 'scheduled ingest run completed with errors')).toBe(true);
  });

  it('completes without retrying when the source is configured off', async () => {
    // Composer resolution 6: Reddit has no credentials, so I-05 leaves it out of the
    // registry entirely. Its scheduled job must not fail and must not retry.
    const { context } = harnessFor(
      [createFakeAdapter({ source: 'hackernews' })],
      [{ source: 'reddit', reason: 'No Reddit credentials configured' }],
    );

    const result = await runIngestJob('reddit', context);

    expect(result.status).toBe('COMPLETE');
    expect(result.sourceStatus).toBe('skipped');
    const records = parseLogLines(capture.lines());
    const skip = records.find(
      (r) => r.msg === 'scheduled ingest skipped a source that is configured off',
    );
    expect(skip?.reason).toBe('No Reddit credentials configured');
    // Nothing at error level: a configured-off source must not turn a cycle red.
    expect(records.filter((r) => r.level === 'error')).toEqual([]);
  });

  it('surfaces no-progress-with-documents at warn without failing the job', async () => {
    // I-05 puts this on the run row and logs it, but deliberately puts nothing in
    // `report.errors`. That is not reversed here: the job still succeeds and is not retried,
    // because the same page would simply be offered again. It is repeated at warn because
    // this is the layer an operator watches.
    const hn = createFakeAdapter({
      source: 'hackernews',
      fetchIncremental: (cursor) =>
        Promise.resolve({
          documents: [makeDocument('hackernews', `doc-${cursor ?? 'first'}`)],
          cursor: cursor ?? 'stuck',
        }),
    });
    const { context } = harnessFor([hn]);

    // First run advances undefined -> 'stuck'; the second is handed 'stuck' and gets it back.
    await runIngestJob('hackernews', context);
    capture.restore();
    capture = captureLog();
    const result = await runIngestJob('hackernews', context);

    expect(result.stopReason).toBe('no-progress-with-documents');
    expect(result.status).toBe('COMPLETE');
    const records = parseLogLines(capture.lines());
    expect(
      records.some(
        (r) =>
          r.msg ===
            'scheduled ingest saw an adapter return documents without advancing its cursor' &&
          r.level === 'warn',
      ),
    ).toBe(true);
  });
});
