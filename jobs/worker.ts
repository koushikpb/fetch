// The long-running process that turns the schedules in lib/config.ts into actual runs.
//
// pg-boss installs and migrates its own schema on `start()` (verified: schema version 37 on
// a database that had only this repo's Drizzle migrations applied), so scheduling adds no
// migration of its own — nothing here belongs in drizzle/, and there is no ordering
// constraint between `pnpm db:migrate` and starting a worker.
import { PgBoss } from 'pg-boss';
import type { Config } from '../lib/config.js';
import { log } from '../lib/log.js';
import { SOURCES, type Source } from '../lib/types.js';
import { runIngestJob } from './ingest-job.js';
import {
  applyIngestSchedules,
  INGEST_DEAD_LETTER_QUEUE,
  INGEST_TICK_QUEUE,
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

  // Everything after `start()` runs against a pg-boss that owns a connection pool and a set
  // of interval timers. Letting a failure escape from here without stopping it leaves those
  // holding the event loop open: the process logs the reason, never exits, and stops being a
  // worker without ever appearing to have stopped. Two inputs `.env.example` actively invites
  // reach this path — a five-field cron pg-boss still rejects, and an expiry it asserts on —
  // so it is an ordinary boot failure, not a remote one.
  try {
    await boss.start();
    await provisionIngestQueues(boss, config.scheduler);
    await applyIngestSchedules(boss, config.scheduler);
    await registerWorkers(boss, context, pollingIntervalSeconds);
  } catch (err) {
    await boss.stop({ close: true, graceful: false, timeout: 1000 });
    throw err;
  }

  log.info('ingest worker started', {
    tickQueue: INGEST_TICK_QUEUE,
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

function isSource(value: unknown): value is Source {
  return typeof value === 'string' && (SOURCES as readonly string[]).includes(value);
}

async function registerWorkers(
  boss: PgBoss,
  context: IngestJobContext,
  pollingIntervalSeconds: number,
): Promise<void> {
  // Forwards each cron tick onto its source's own queue, which is where the lock lives. The
  // point of doing it here rather than scheduling straight onto the source queue is the
  // `null` below: pg-boss's own scheduler discards a policy refusal, so without this a source
  // whose runs overrun its cadence just quietly ran less often than it was configured to.
  await boss.work<IngestJobData>(
    INGEST_TICK_QUEUE,
    { batchSize: 1, pollingIntervalSeconds },
    async (jobs) => {
      for (const job of jobs) {
        const source = job.data.source;
        if (!isSource(source)) {
          log.error('ingest tick carried an unrecognized source; nothing was run', {
            received: source,
            tick_job_id: job.id,
          });
          continue;
        }
        const queue = ingestQueueName(source);
        let jobId: string | null;
        try {
          jobId = await boss.send(queue, { source } satisfies IngestJobData);
        } catch (err) {
          // The other half of the blindness this queue exists to remove. A refused forward
          // returns `null` and is handled below; a *throwing* one — the database unreachable
          // for the moment the tick lands — would otherwise leave the failure only in
          // `pgboss.job.output` on a tick queue that has `retryLimit: 0` and no dead letter,
          // i.e. no line at any level and nothing to find later.
          log.error('scheduled ingest tick could not be dispatched', {
            source,
            queue,
            tick_job_id: job.id,
            error: err,
            effect:
              'this cadence interval is skipped; the next tick dispatches normally and resumes from the same cursor',
          });
          // Rethrown so the tick job records the failure too, rather than completing as if it
          // had dispatched something. Safe with `batchSize: 1` — there is no sibling job in
          // this batch whose successful dispatch would be misreported as failed.
          throw err;
        }
        if (jobId === null) {
          log.warn('scheduled ingest tick dropped: a run of this source is already pending', {
            source,
            queue,
            tick_job_id: job.id,
            effect:
              'this cadence interval is skipped; no evidence is lost because the next run resumes from the same cursor',
          });
          continue;
        }
        log.info('scheduled ingest tick dispatched', { source, queue, job_id: jobId });
      }
    },
  );

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
          const result = await runIngestJob(source, context);
          // pg-boss races the handler against `expireInSeconds` in this process and aborts
          // this signal when the deadline wins. It cannot stop the run — the orchestrator has
          // no cancellation seam — so by here the job has already been failed and requeued
          // while this run kept going, and a concurrent run of the same source is possible.
          // Nothing else reports that: the queue looks healthy and the retry looks ordinary.
          if (job.signal.aborted) {
            log.error('scheduled ingest run outlived its expiry; a concurrent run is possible', {
              source,
              job_id: job.id,
              run_id: result.runId,
              expireInSeconds: job.expireInSeconds,
              effect:
                'pg-boss has already requeued this job; raise INGEST_JOB_EXPIRY_SECONDS above this run duration',
            });
          }
          results.push(result);
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
}
