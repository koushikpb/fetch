// Queue and schedule provisioning (SPEC I-06 criteria 1 and 2). Everything here is applied
// on every worker boot, which is what makes the settings in lib/config.ts actually take
// effect rather than only describing what the first boot ever created.
import type { PgBoss, UpdateQueueOptions } from 'pg-boss';
import type { SchedulerConfig } from '../lib/config.js';
import { log } from '../lib/log.js';
import { SOURCES, type Source } from '../lib/types.js';

/**
 * One queue per source, which is what makes criterion 2's lock mean "the same source twice"
 * rather than "the whole pipeline twice". Two different sources running at once is fine and
 * desirable; the same source twice is not, because both would start from the same persisted
 * cursor and duplicate every fetch.
 */
export function ingestQueueName(source: Source): string {
  return `ingest.${source}`;
}

/**
 * Where a job lands once it has exhausted its retries. Criterion 3 requires giving up after
 * a configurable count; this is the half of that requirement that keeps the giving-up from
 * being silent — pg-boss copies the exhausted job here, payload, failure output and all, and
 * jobs/worker.ts works this queue purely to log it at error level.
 */
export const INGEST_DEAD_LETTER_QUEUE = 'ingest.dead-letter';

/**
 * A give-up is the rarest and most important event this stage produces, so its record
 * outlives pg-boss's 7-day default by a wide margin. Retention, not cadence — it answers
 * "what broke while I was away", which no operator setting needs to tune.
 */
const DEAD_LETTER_RETENTION_SECONDS = 30 * 24 * 60 * 60;

/**
 * `exclusive` — one job per source queued *or* active — rather than `singleton`, which caps
 * only the active count. Both satisfy criterion 2, and both were verified against a real
 * Postgres; the difference is what happens to the ticks that arrive while a run is in
 * flight. Under `singleton` they queue up and then all run back to back the moment the slow
 * run finishes, hammering a third-party API exactly when it was already struggling. Under
 * `exclusive` the send is refused outright and the tick is dropped, which for cursor-based
 * ingestion loses nothing at all: the next tick resumes from the same persisted position the
 * dropped one would have.
 */
const INGEST_QUEUE_POLICY = 'exclusive';

function ingestQueueOptions(scheduler: SchedulerConfig): UpdateQueueOptions {
  return {
    retryLimit: scheduler.retryLimit,
    retryDelay: scheduler.retryDelaySeconds,
    // Criterion 3 asks for backoff specifically, so this is on rather than a fixed delay:
    // an upstream that just rate-limited us is the common reason a run fails, and retrying
    // it on a fixed short interval is how a transient failure becomes a sustained one.
    retryBackoff: true,
    retryDelayMax: scheduler.retryDelayMaxSeconds,
    expireInSeconds: scheduler.jobExpirySeconds,
    deadLetter: INGEST_DEAD_LETTER_QUEUE,
  };
}

/**
 * Creates every ingest queue and then *updates* it with the current configuration.
 *
 * The update is not redundant. `createQueue` was verified to be a no-op against a queue that
 * already exists — it silently keeps the options the queue was first created with — so a
 * create-only boot would mean changing `INGEST_RETRY_LIMIT` and restarting had no effect
 * whatsoever after the very first run, and the setting would be configurable in name only.
 */
export async function provisionIngestQueues(
  boss: PgBoss,
  scheduler: SchedulerConfig,
): Promise<void> {
  // `policy` is create-time only — pg-boss rejects an update that carries one, even an
  // unchanged one ("queue policy cannot be changed after creation"), so it is deliberately
  // absent from every object passed to `updateQueue` below.
  const deadLetter: UpdateQueueOptions = { deleteAfterSeconds: DEAD_LETTER_RETENTION_SECONDS };
  // First, because the source queues below name it as their dead letter target.
  await boss.createQueue(INGEST_DEAD_LETTER_QUEUE, { ...deadLetter, policy: 'standard' });
  await boss.updateQueue(INGEST_DEAD_LETTER_QUEUE, deadLetter);

  const options = ingestQueueOptions(scheduler);
  for (const source of SOURCES) {
    const name = ingestQueueName(source);
    await boss.createQueue(name, { ...options, policy: INGEST_QUEUE_POLICY });
    await boss.updateQueue(name, options);
  }
  log.info('ingest queues provisioned', {
    policy: INGEST_QUEUE_POLICY,
    retryLimit: scheduler.retryLimit,
    retryDelaySeconds: scheduler.retryDelaySeconds,
    retryDelayMaxSeconds: scheduler.retryDelayMaxSeconds,
    jobExpirySeconds: scheduler.jobExpirySeconds,
    deadLetterQueue: INGEST_DEAD_LETTER_QUEUE,
  });
}

/**
 * Registers each source's cron, and *unregisters* the ones switched off.
 *
 * The unschedule half is the part that is easy to leave out and expensive to omit: pg-boss
 * keeps schedules in the database, not in this process, so a schedule registered by an
 * earlier boot goes on firing forever after its setting is removed. Without this, switching
 * a source off would appear to work — nothing in the configuration mentions it any more —
 * while the job kept running on the old cadence. Unscheduling a source that was never
 * scheduled is a no-op, so this is safe to run on every boot.
 */
export async function applyIngestSchedules(
  boss: PgBoss,
  scheduler: SchedulerConfig,
): Promise<void> {
  for (const source of SOURCES) {
    const name = ingestQueueName(source);
    const cron = scheduler.cron[source];
    if (cron === undefined) {
      await boss.unschedule(name);
      log.info('ingest schedule disabled for source', { source, queue: name });
      continue;
    }
    // Upserts: re-registering the same queue with a different expression replaces the
    // stored one rather than adding a second, so a changed setting takes effect on restart.
    await boss.schedule(name, cron, { source } satisfies { source: Source }, {
      tz: scheduler.timezone,
    });
    log.info('ingest schedule registered', { source, queue: name, cron, tz: scheduler.timezone });
  }
}
