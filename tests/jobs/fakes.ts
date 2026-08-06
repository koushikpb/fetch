// Shared doubles for the I-06 scheduling suites. Deliberately doubles of the *adapters* and
// the *persistence seams* rather than of `runIngest` itself: the questions these suites ask
// — does a job retry, does the lock hold, is a configured-off source an error — are all
// decided by what the real orchestrator reports, so stubbing it out would leave the answers
// asserted against a fixture of the implementer's own opinion.
import type {
  CursorStore,
  DocumentSink,
  IngestRunFinish,
  IngestRunRecorder,
} from '../../ingest/index.js';
import type { Document, Source } from '../../lib/types.js';
import type {
  BackfillRange,
  Cursor,
  FetchPage,
  HealthCheckResult,
  SourceAdapter,
} from '../../sources/types.js';

export interface FakeAdapterCalls {
  fetchIncremental: number;
  fetchBackfill: number;
  checkHealth: number;
}

export interface FakeAdapter extends SourceAdapter {
  readonly calls: FakeAdapterCalls;
}

export interface FakeAdapterOptions {
  readonly source: Source;
  readonly health?: HealthCheckResult;
  readonly fetchIncremental?: (cursor: Cursor | undefined) => Promise<FetchPage>;
}

export function makeDocument(source: Source, sourceId: string): Document {
  return {
    source,
    sourceId,
    url: `https://example.test/${source}/${sourceId}`,
    authorHandle: 'someone',
    title: null,
    body: `body ${sourceId}`,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    engagement: {},
    raw: {},
  };
}

export function createFakeAdapter(options: FakeAdapterOptions): FakeAdapter {
  const calls: FakeAdapterCalls = { fetchIncremental: 0, fetchBackfill: 0, checkHealth: 0 };
  const health = options.health ?? { healthy: true, detail: 'ok' };
  const fetchIncremental =
    options.fetchIncremental ??
    ((): Promise<FetchPage> =>
      Promise.resolve({ documents: [makeDocument(options.source, 'a1')], cursor: undefined }));

  return {
    source: options.source,
    calls,
    fetchIncremental: async (cursor: Cursor | undefined): Promise<FetchPage> => {
      calls.fetchIncremental += 1;
      return fetchIncremental(cursor);
    },
    fetchBackfill: async (
      _range: BackfillRange,
      cursor: Cursor | undefined,
    ): Promise<FetchPage> => {
      calls.fetchBackfill += 1;
      return fetchIncremental(cursor);
    },
    checkHealth: async (): Promise<HealthCheckResult> => {
      calls.checkHealth += 1;
      return Promise.resolve(health);
    },
  };
}

export interface MemoryDocumentSink extends DocumentSink {
  readonly inserted: Document[];
}

export function createMemoryDocumentSink(): MemoryDocumentSink {
  const inserted: Document[] = [];
  const seen = new Set<string>();
  return {
    inserted,
    insert: async (documents: readonly Document[]): Promise<number> => {
      let created = 0;
      for (const document of documents) {
        const key = `${document.source}:${document.sourceId}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        inserted.push(document);
        created += 1;
      }
      return Promise.resolve(created);
    },
  };
}

export function createMemoryCursorStore(): CursorStore {
  const cursors = new Map<Source, Cursor>();
  return {
    get: (source: Source): Promise<Cursor | undefined> => Promise.resolve(cursors.get(source)),
    set: (source: Source, cursor: Cursor): Promise<void> => {
      cursors.set(source, cursor);
      return Promise.resolve();
    },
  };
}

export interface MemoryRunRecorder extends IngestRunRecorder {
  readonly finished: Map<string, IngestRunFinish>;
}

export function createMemoryRunRecorder(): MemoryRunRecorder {
  const finished = new Map<string, IngestRunFinish>();
  let next = 0;
  return {
    finished,
    start: (): Promise<string> => {
      next += 1;
      return Promise.resolve(`run-${String(next)}`);
    },
    finish: (runId: string, result: IngestRunFinish): Promise<void> => {
      finished.set(runId, result);
      return Promise.resolve();
    },
  };
}

/**
 * Parses the structured lines lib/log.ts wrote to a captured stdout. Assertions go through
 * this rather than substring-matching the raw output, so a test that expects a warning cannot
 * be satisfied by the same words appearing at a different level or in a different field.
 */
export function parseLogLines(chunks: readonly string[]): Record<string, unknown>[] {
  return chunks
    .join('')
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}
