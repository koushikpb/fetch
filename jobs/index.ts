// Public surface of the scheduling stage. scripts/worker.ts enters here; nothing outside
// this directory should reach into ./worker.js, ./queues.js, or ./ingest-job.js directly.
export { startIngestWorker } from './worker.js';
export type { IngestWorker, IngestWorkerOptions } from './worker.js';
export {
  applyIngestSchedules,
  INGEST_DEAD_LETTER_QUEUE,
  ingestQueueName,
  provisionIngestQueues,
} from './queues.js';
export { restrictRegistryToSource, runIngestJob } from './ingest-job.js';
export type { IngestJobContext, IngestJobData, IngestJobResult } from './types.js';
