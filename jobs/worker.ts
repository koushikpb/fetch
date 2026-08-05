// The long-running process that turns the schedules in lib/config.ts into actual runs.
//
// pg-boss installs and migrates its own schema on `start()` (verified: schema version 37 on
// a database that had only this repo's Drizzle migrations applied), so scheduling adds no
// migration of its own — nothing here belongs in drizzle/, and there is no ordering
// constraint between `pnpm db:migrate` and starting a worker.
import { PgBoss } from 'pg-boss';
import type { Config } from '../lib/config.js';
import { log } from '../lib/log.js';
import { SOURCES } from '../lib/types.js';
import { runIngestJob } from './ingest-job.js';
import {
  applyIngestSchedules,
  INGEST_DEAD_LETTER_QUEUE,
  ingestQueueName,
  provisionIngestQueues,
} from './queues.js';
import type { IngestJobContext, IngestJobData, IngestJobResult } from './types.js';

export interface IngestWorkerOptions {
  readonly config: Config;
  readonly context: IngestJobContext;
  /**
   * Overrides the poll interval below. Only a test has a reason to set this: it is what
   * keeps a suite that must observe a job actually being picked up from spending seconds per
   * assertion waiting out a production-sized interval.
   */
  readonly pollingIntervalSeconds?: number;
}

export interface IngestWorker {
  readonly boss: PgBoss;
  /** Stops polling, waits for an in-flight run to finish, and closes pg-boss's own pool. */
  stop(): Promise<void>;
}

/**
 * How long a graceful stop waits for a run that is already in flight. Long enough that an
 * ordinary run finishes rather than being abandoned partway; the orchestrator persists its
 * cursor per page either way, so an abandoned run resumes rather than restarts.
 */
const STOP_GRACE_MS = 30_000;

/**
 * Longer than pg-boss's own 2-second default, because these queues are cron-driven: the
 * shortest configured cadence is measured in minutes, so a few seconds of pickup latency is
 * invisible, while polling four queues every two seconds is a steady two queries a second of
 * idle traffic that buys nothing.
 */
const DEFAULT_POLLING_INTERVAL_SECONDS = 5;

interface DeadLetterWorkOptions {
  readonly batchSize: 1;
  readonly pollingIntervalSeconds: number;
  readonly includeMetadata: true;
}

/**
 * Boots pg-boss, provisions the per-source queues, applies the configured schedules, and
 * starts working every one of them plus the dead letter queue.
 *
 * Takes its `IngestJobContext` already built rather than a database handle, so this
 * directory never imports db/ and a test can drive real jobs against in-memory sinks.
 */
export async function startIngestWorker(options: IngestWorkerOptions): Promise<IngestWorker> {
  const { config, context } = options;
  const pollingIntervalSeconds = options.pollingIntervalSeconds ?? DEFAULT_POLLING_INTERVAL_SECONDS;
  const boss = new PgBoss({ connectionString: config.databaseUrl });

  // pg-boss is an EventEmitter, and an unhandled 'error' event takes the process down. These
  // are its own internal faults (a maintenance query failing, the listener dropping) — not a
  // job's — so they belong in the log rather than propagating into a job's retry accounting.
  boss.on('error', (error: Error) => {
    log.error('pg-boss raised an internal error', { error });
  });
  boss.on('warning', (warning) => {
    log.warn('pg-boss raised a warning', { warning: warning.message, data: warning.data });
  });

  await boss.start();
  await provisionIngestQueues(boss, config.scheduler);
  await applyIngestSchedules(boss, config.scheduler);

  for (const source of SOURCES) {
    // The source comes from the queue being worked, not from the job payload: the queue is
    // what the per-source lock is attached to, so taking it from anywhere else would let a
    // malformed payload run a source under another source's lock.
    await boss.work<IngestJobData, IngestJobResult[]>(
      ingestQueueName(source),
      { batchSize: 1, pollingIntervalSeconds },
      async (jobs) => {
        const results: IngestJobResult[] = [];
        for (const job of jobs) {
          log.info('scheduled ingest job started', { source, job_id: job.id });
          results.push(await runIngestJob(source, context));
        }
        return results;
      },
    );
  }

  // All three type arguments are spelled out because supplying any of them switches off
  // inference for the rest: left to its default, the options type parameter is the wide
  // `WorkOptions`, whose `includeMetadata` is a plain `boolean` rather than the literal
  // `true` that selects the handler whose jobs carry `sourceName`/`sourceRetryCount`/`output`
  // — the four fields the give-up log line below is made of.
  await boss.work<IngestJobData, void, DeadLetterWorkOptions>(
    INGEST_DEAD_LETTER_QUEUE,
    { batchSize: 1, pollingIntervalSeconds, includeMetadata: true },
    async (jobs) => {
      for (const job of jobs) {
        // The one place a permanent give-up becomes something an operator hears about. The
        // job row itself is the durable half of that record; this is the half that shows up
        // the moment it happens.
        log.error('scheduled ingest gave up on a source after exhausting its retries', {
          source: job.data.source,
          origin_queue: job.sourceName,
          original_job_id: job.sourceId,
          attempts: (job.sourceRetryCount ?? 0) + 1,
          dead_letter_job_id: job.id,
          failure: job.output,
          effect:
            'this source will not be retried again until its next scheduled run; the failing run is recorded on the runs table',
        });
      }
    },
  );

  log.info('ingest worker started', {
    queues: SOURCES.map(ingestQueueName),
    deadLetterQueue: INGEST_DEAD_LETTER_QUEUE,
  });

  return {
    boss,
    stop: async () => {
      await boss.stop({ close: true, graceful: true, timeout: STOP_GRACE_MS });
    },
  };
}
