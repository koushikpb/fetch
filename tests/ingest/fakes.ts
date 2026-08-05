// In-memory implementations of ingest/'s three persistence seams, plus the one adapter
// behaviour sources/fake-adapter.ts cannot express.
//
// `createFakeAdapter` derives its cursor from the page index (`String(index + 1)`), so it
// always advances and can never hand back the cursor it was given — which is exactly the
// shape the stall predicate detects. `createStallingAdapter` below fills that gap and
// nothing else; every other scenario in these tests uses the shared fake, per its own doc
// comment ("I-05's orchestrator tests are all expected to build on this").
import type { Document, Source } from '../../lib/types.js';
import type {
  BackfillRange,
  Cursor,
  FetchPage,
  HealthCheckResult,
  SourceAdapter,
} from '../../sources/types.js';
import type {
  CursorStore,
  DocumentSink,
  IngestRunFinish,
  IngestRunRecorder,
} from '../../ingest/types.js';

/**
 * Dedups on `(source, sourceId)` in memory, the same key the real unique constraint uses, so
 * an orchestrator test can assert the re-run-inserts-nothing accounting without Postgres.
 * The database-level proof of the same criterion is tests/ingest/ingest-db.test.ts, against
 * the real constraint — this fake proves the orchestrator reports what the sink tells it,
 * not that the constraint works.
 */
export interface FakeDocumentSink extends DocumentSink {
  readonly stored: Map<string, Document>;
  readonly offered: Document[];
  failNext(error: Error | undefined): void;
}

export function createFakeDocumentSink(): FakeDocumentSink {
  const stored = new Map<string, Document>();
  const offered: Document[] = [];
  let failure: Error | undefined;

  return {
    stored,
    offered,
    failNext(error) {
      failure = error;
    },
    async insert(documents) {
      offered.push(...documents);
      if (failure !== undefined) {
        const toThrow = failure;
        failure = undefined;
        throw toThrow;
      }
      let inserted = 0;
      for (const document of documents) {
        const key = `${document.source}:${document.sourceId}`;
        if (!stored.has(key)) {
          stored.set(key, document);
          inserted += 1;
        }
      }
      return inserted;
    },
  };
}

export interface FakeCursorStore extends CursorStore {
  readonly values: Map<Source, Cursor>;
  /** Every `set` in order, so a test can assert what was persisted and when. */
  readonly writes: { source: Source; cursor: Cursor }[];
  /** Every cursor `get` handed back, so a test can assert replay is verbatim. */
  readonly reads: { source: Source; cursor: Cursor | undefined }[];
  failOnGet(error: Error | undefined): void;
}

export function createFakeCursorStore(initial: Iterable<[Source, Cursor]> = []): FakeCursorStore {
  const values = new Map<Source, Cursor>(initial);
  const writes: { source: Source; cursor: Cursor }[] = [];
  const reads: { source: Source; cursor: Cursor | undefined }[] = [];
  let getFailure: Error | undefined;

  return {
    values,
    writes,
    reads,
    failOnGet(error) {
      getFailure = error;
    },
    async get(source) {
      if (getFailure !== undefined) {
        throw getFailure;
      }
      const cursor = values.get(source);
      reads.push({ source, cursor });
      return cursor;
    },
    async set(source, cursor) {
      values.set(source, cursor);
      writes.push({ source, cursor });
    },
  };
}

export interface RecordedRun {
  readonly runId: string;
  readonly result: IngestRunFinish;
}

export interface FakeRunRecorder extends IngestRunRecorder {
  readonly started: string[];
  readonly finished: RecordedRun[];
  failOnFinish(error: Error | undefined): void;
}

export function createFakeRunRecorder(): FakeRunRecorder {
  const started: string[] = [];
  const finished: RecordedRun[] = [];
  let finishFailure: Error | undefined;

  return {
    started,
    finished,
    failOnFinish(error) {
      finishFailure = error;
    },
    async start(stage) {
      const runId = `run-${started.length + 1}-${stage}`;
      started.push(runId);
      return runId;
    },
    async finish(runId, result) {
      if (finishFailure !== undefined) {
        throw finishFailure;
      }
      finished.push({ runId, result });
    },
  };
}

export interface StallingAdapterOptions {
  readonly source: Source;
  /** Returned verbatim as this page's cursor, whatever cursor came in. */
  readonly page: FetchPage;
}

export interface StallingAdapter extends SourceAdapter {
  callCount(): number;
  cursorsSeen(): readonly (Cursor | undefined)[];
}

/**
 * An adapter that always returns exactly the cursor it was handed, alongside the supplied
 * page — the deliberate "re-attempt this page rather than skip past it" behaviour two of the
 * three real adapters implement when a transient failure interrupts them.
 */
export function createStallingAdapter(options: StallingAdapterOptions): StallingAdapter {
  const seen: (Cursor | undefined)[] = [];
  const pageFor = (cursor: Cursor | undefined): FetchPage => {
    seen.push(cursor);
    return { ...options.page, cursor };
  };
  return {
    source: options.source,
    async fetchIncremental(cursor) {
      return pageFor(cursor);
    },
    async fetchBackfill(_range: BackfillRange, cursor) {
      return pageFor(cursor);
    },
    async checkHealth(): Promise<HealthCheckResult> {
      return { healthy: true, detail: 'stalling fake: reachable' };
    },
    callCount: () => seen.length,
    cursorsSeen: () => [...seen],
  };
}

let documentSequence = 0;

/** A minimally valid `Document`; `sourceId` defaults to a fresh unique value per call. */
export function makeDocument(source: Source, sourceId?: string): Document {
  documentSequence += 1;
  const id = sourceId ?? `doc-${documentSequence}`;
  return {
    source,
    sourceId: id,
    url: `https://example.test/${source}/${id}`,
    authorHandle: 'example-author',
    title: `Title ${id}`,
    body: `Body for ${id}`,
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    engagement: { score: 1 },
    raw: { id },
  };
}
