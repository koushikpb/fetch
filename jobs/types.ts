// Types for the scheduling stage (SPEC I-06) — the layer that decides *when* ingestion runs
// and what a failed run is allowed to do about it. It owns no pipeline logic of its own:
// every job here is a call into `runIngest`, which I-05 already made resumable (cursors are
// persisted) and idempotent (`documents` dedups on `(source, source_id)`). Those two
// properties are what make a retry safe, and they are also why nothing in this directory
// adds retry-like logic of its own — the orchestrator already bounds its own work per run.
//
// The imports from `../ingest/index.js` and `../sources/registry.js` are the same designated
// -seam exception ingest/types.ts records in its own header: CLAUDE.md's "no cross-directory
// type imports except from lib/types.ts" targets shared *data shapes*, and both of those
// modules are explicitly the one public door onto their directory — ingest/index.ts names
// "I-06 (pg-boss scheduling)" as an expected caller, and sources/registry.ts is the sole
// route to an adapter. Reaching past either would be the violation; entering through them is
// the contract.
import type {
  CursorStore,
  DocumentSink,
  IngestRunRecorder,
  IngestRunStatus,
  IngestStopReason,
  IngestTotals,
  SourceRunStatus,
} from '../ingest/index.js';
import type { Source } from '../lib/types.js';
import type { SourceRegistry } from '../sources/registry.js';

/**
 * A scheduled job's payload. The queue is already per-source, so the handler takes the
 * source from the queue it is working rather than from here — this rides along so a job
 * sitting in the dead letter queue says what it was for without anyone having to parse a
 * queue name back into a source.
 */
export interface IngestJobData {
  readonly source: Source;
}

/** Everything one scheduled run needs, built once by the worker and shared by every job. */
export interface IngestJobContext {
  /** The full production registry; each job narrows it to its own source before running. */
  readonly registry: SourceRegistry;
  readonly documents: DocumentSink;
  readonly cursors: CursorStore;
  readonly runs: IngestRunRecorder;
}

/**
 * What a scheduled run reports back. Stored by pg-boss as the job's `output`, which is what
 * makes a completed job's row self-explanatory — `runId` in particular is the join back to
 * the `runs` table where the full per-source accounting lives.
 */
export interface IngestJobResult {
  readonly source: Source;
  readonly runId: string;
  readonly status: IngestRunStatus;
  /** This source's own disposition, which a whole-run status necessarily flattens. */
  readonly sourceStatus: SourceRunStatus;
  readonly stopReason: IngestStopReason;
  readonly totals: IngestTotals;
}
