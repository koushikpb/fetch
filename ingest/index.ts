// Public surface of the ingest stage. I-06 (pg-boss scheduling) and scripts/ingest.ts both
// enter here; nothing outside this directory should reach into ./orchestrator.js or
// ./repo.js directly.
export { runIngest, DEFAULT_MAX_PAGES_PER_RUN, INGEST_STAGE } from './orchestrator.js';
export type { RunIngestOptions } from './orchestrator.js';
export {
  createDrizzleCursorStore,
  createDrizzleDocumentSink,
  createDrizzleIngestRunRecorder,
  DEFAULT_INSERT_BATCH_SIZE,
} from './repo.js';
export type {
  CursorStore,
  DocumentSink,
  IngestErrorKind,
  IngestErrorRecord,
  IngestMode,
  IngestReport,
  IngestRunFinish,
  IngestRunRecorder,
  IngestRunStatus,
  IngestStopReason,
  IngestTotals,
  SourceIngestCounts,
  SourceRunStatus,
} from './types.js';
