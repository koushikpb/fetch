// Types for normalizing adapter output into the append-only `documents` table (SPEC I-05).
//
// The three persistence seams below (`DocumentSink`, `CursorStore`, `IngestRunRecorder`) are
// narrow interfaces rather than the Drizzle `Db` handle, the same shape lib/llm.ts's
// `RunsRepo` uses and for the same reason: the orchestrator's behavioural rules — dedup
// accounting, the stall predicate, per-source error isolation — are provable against
// in-memory fakes, while the SQL that backs them is proved separately against a real
// Postgres (tests/ingest/ingest-db.test.ts). ingest/repo.ts holds the only implementations
// that touch the database.
//
// `Cursor` and `SkippedSource` are imported from sources/ rather than lib/types.ts. That is
// the same exception sources/types.ts's own header records for `AppError`: CLAUDE.md's
// "no cross-directory type imports except from lib/types.ts" targets shared *data shapes*,
// and sources/types.ts is explicitly "the seam I-05's orchestrator calls exclusively through
// sources/registry.ts" — a reference to the one designated seam, not to another module's
// internal data model.
import type { Document, Source } from '../lib/types.js';
import type { BackfillRange, Cursor } from '../sources/types.js';

/**
 * Why a source's page loop stopped. Recorded per source on the `runs` row because "stopped
 * after one page" and "walked to exhaustion" are the same zero-error outcome from the
 * outside, and the difference is the whole story when a source's counts look thin.
 */
export type IngestStopReason =
  /** The adapter returned `cursor: undefined` — caught up, or structurally unable to page on. */
  | 'exhausted'
  /**
   * The adapter handed back the cursor it was given, without a `partial` outcome. Calling
   * again with an identical cursor can only reproduce the same page, so there is nothing
   * further to do this run. Not a fault: the App Store adapter's incremental fetch never
   * returns `cursor: undefined` at all (it always encodes its per-pair high-water state), so
   * this is its ordinary steady-state terminator.
   */
  | 'no-progress'
  /** The stall predicate fired: identical cursor *and* a `partial` outcome. See the orchestrator. */
  | 'stalled'
  /** Hit `maxPagesPerRun`. Coverage is incomplete but resumable — the cursor is persisted. */
  | 'page-limit'
  /** The adapter threw. */
  | 'error'
  /** The loop never started: the source was skipped or reported unhealthy. */
  | 'not-attempted';

export type SourceRunStatus =
  /** Ran to a stop with no error. May still carry `truncatedReasons` — truncation is a coverage fact, not a failure. */
  | 'complete'
  /** At least one page returned `outcome.kind === 'partial'`; documents from those pages were still written. */
  | 'partial'
  /** The stall predicate fired and the source was halted. */
  | 'stalled'
  /** The adapter threw out of `fetchIncremental`/`fetchBackfill`. */
  | 'failed'
  /** `checkHealth()` reported `healthy: false`, so no fetch was attempted. */
  | 'unhealthy'
  /** No adapter registered for this source — configured off (see `SkippedSource`). */
  | 'skipped';

/** `runs.status`. `PARTIAL` is the value SPEC I-05 criterion 2 names explicitly. */
export type IngestRunStatus = 'COMPLETE' | 'PARTIAL' | 'FAILED';

export interface SourceIngestCounts {
  readonly source: Source;
  readonly status: SourceRunStatus;
  /** Documents the adapter handed over, before dedup. */
  readonly fetched: number;
  /** Rows the `documents` insert actually created. */
  readonly inserted: number;
  /** `fetched - inserted`: already present under the same `(source, source_id)`. */
  readonly duplicates: number;
  readonly pages: number;
  readonly durationMs: number;
  readonly stopReason: IngestStopReason;
  /**
   * Every `truncated` reason (and every `partial.truncatedReason` rider) seen this run,
   * verbatim. A standing fact about coverage, not an error — kept separate from `errors` so
   * a structurally capped source does not read as a broken one.
   */
  readonly truncatedReasons: readonly string[];
  /** `checkHealth`'s detail, or the reason a source was skipped. Absent when neither applies. */
  readonly detail?: string;
}

export type IngestErrorKind =
  /** Thrown out of the adapter. */
  | 'thrown'
  /** Returned as `outcome: { kind: 'partial', error }` alongside salvaged documents. */
  | 'partial'
  /** The stall predicate fired. */
  | 'stalled'
  /** `checkHealth()` reported unhealthy. */
  | 'unhealthy'
  /** Raised outside any single source's boundary — the run itself could not complete. */
  | 'run';

/**
 * The `runs.errors` entry shape. A plain object, not the error itself: `Error.message` and
 * `Error.stack` are non-enumerable, so a jsonb column handed a raw error stores `{}` (the
 * same trap lib/log.ts's `serializeError` documents). `stack` is deliberately absent —
 * `runs` is queried by humans looking for what broke, and `context` plus `code` answer that
 * without turning every row into a wall of frames.
 */
export interface IngestErrorRecord {
  readonly source: Source | null;
  readonly kind: IngestErrorKind;
  readonly name: string;
  readonly code: string | undefined;
  readonly message: string;
  readonly context: Record<string, unknown> | undefined;
}

export interface IngestReport {
  readonly runId: string;
  readonly status: IngestRunStatus;
  readonly startedAt: Date;
  readonly finishedAt: Date;
  readonly durationMs: number;
  /** One entry per source in `SOURCES` — every source is accounted for, including skipped ones. */
  readonly counts: readonly SourceIngestCounts[];
  readonly errors: readonly IngestErrorRecord[];
  readonly totals: IngestTotals;
}

export interface IngestTotals {
  readonly fetched: number;
  readonly inserted: number;
  readonly duplicates: number;
}

/**
 * Incremental resumes from the persisted per-source cursor and writes the new one back;
 * backfill walks a range from scratch each time and persists nothing (see db/schema.ts's
 * `sourceCursors` comment for why the two cursors do not share a row).
 */
export type IngestMode =
  { readonly kind: 'incremental' } | { readonly kind: 'backfill'; readonly range: BackfillRange };

/** Writes documents, deduping on `(source, source_id)`, and reports how many rows were new. */
export interface DocumentSink {
  /** Returns the number of rows actually inserted — never the number offered. */
  insert(documents: readonly Document[]): Promise<number>;
}

export interface CursorStore {
  get(source: Source): Promise<Cursor | undefined>;
  /**
   * Stores `cursor` verbatim. Only ever called with a defined cursor: there is no `clear`,
   * because discarding a high-water mark means the next run restarts from the adapter's
   * initial lookback and permanently skips everything older than it — and a skip, unlike a
   * re-fetch, cannot be undone (composer ruling: err toward re-fetching, never toward
   * skipping).
   */
  set(source: Source, cursor: Cursor): Promise<void>;
}

export interface IngestRunFinish {
  readonly status: IngestRunStatus;
  readonly finishedAt: Date;
  readonly counts: Record<string, unknown>;
  readonly errors: readonly IngestErrorRecord[];
}

export interface IngestRunRecorder {
  /** Inserts the `runs` row up front and returns its id, so a crash mid-run still has a row to finalize. */
  start(stage: string): Promise<string>;
  finish(runId: string, result: IngestRunFinish): Promise<void>;
}
