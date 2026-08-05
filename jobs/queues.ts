// Queue and schedule provisioning (SPEC I-06 criteria 1 and 2). Everything here is applied
// on every worker boot, which is what makes the settings in lib/config.ts actually take
// effect rather than only describing what the first boot ever created.
import type { PgBoss, Schedule, UpdateQueueOptions } from 'pg-boss';
import type { SchedulerConfig } from '../lib/config.js';
import { AppError } from '../lib/errors.js';
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
 * Where the cron schedules actually point. Every tick lands here first and is forwarded to
 * the source's own queue by jobs/worker.ts.
 *
 * The indirection exists to make a *refused* tick observable. Scheduling straight onto an
 * `exclusive` source queue works, but pg-boss's own scheduler swallows the refusal: its
 * `onSendIt` re-emits only *rejected* sends, and a policy refusal resolves to `null`. A tick
 * dropped because the previous run is still going therefore produced no line at any level,
 * which is what made a stuck source invisible. Forwarding through a queue this code owns puts
 * the `null` somewhere it can be logged.
 *
 * `standard` policy, because this queue must never refuse anything — refusing here would
 * recreate the very blindness it exists to remove.
 */
export const INGEST_TICK_QUEUE = 'ingest.tick';

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
 * A tick is only worth acting on while it is roughly current: it carries no payload beyond
 * "run this source now", and a source resumes from its cursor regardless. Ten minutes keeps a
 * worker that was down over several ticks from replaying every one of them on startup, which
 * would achieve one run and a burst of refusal warnings for the rest.
 */
const TICK_RETENTION_SECONDS = 600;

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

/**
 * Makes a crashed worker's orphaned job recoverable.
 *
 * A worker killed mid-run leaves its job `active` forever as far as the queue is concerned,
 * and under `exclusive` that locks the source out completely — measured as every subsequent
 * send being refused until `expireInSeconds` elapsed, an hour by default, with nothing
 * logged. With a heartbeat, the worker refreshes `heartbeat_on` every `heartbeatSeconds / 2`
 * while a handler runs, and pg-boss's supervisor fails any active job whose heartbeat has
 * gone stale, returning it to `retry` where a live worker picks it up.
 *
 * 60 seconds (pg-boss requires >= 10) because reclaim latency is this plus the supervisor's
 * own monitor interval, also 60 by default — so roughly two minutes against a shortest
 * cadence of fifteen, while staying long enough that an ordinary pause inside a run is never
 * mistaken for a dead worker.
 */
const INGEST_HEARTBEAT_SECONDS = 60;

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
    heartbeatSeconds: INGEST_HEARTBEAT_SECONDS,
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

  const tick: UpdateQueueOptions = { retentionSeconds: TICK_RETENTION_SECONDS, retryLimit: 0 };
  await boss.createQueue(INGEST_TICK_QUEUE, { ...tick, policy: 'standard' });
  await boss.updateQueue(INGEST_TICK_QUEUE, tick);

  const options = ingestQueueOptions(scheduler);
  for (const source of SOURCES) {
    const name = ingestQueueName(source);
    await boss.createQueue(name, { ...options, policy: INGEST_QUEUE_POLICY });
    await boss.updateQueue(name, options);
    await assertQueuePolicy(boss, name);
  }
  log.info('ingest queues provisioned', {
    policy: INGEST_QUEUE_POLICY,
    retryLimit: scheduler.retryLimit,
    retryDelaySeconds: scheduler.retryDelaySeconds,
    retryDelayMaxSeconds: scheduler.retryDelayMaxSeconds,
    jobExpirySeconds: scheduler.jobExpirySeconds,
    heartbeatSeconds: INGEST_HEARTBEAT_SECONDS,
    tickQueue: INGEST_TICK_QUEUE,
    deadLetterQueue: INGEST_DEAD_LETTER_QUEUE,
  });
}

/**
 * The one queue setting `provisionIngestQueues` cannot repair, checked rather than assumed.
 *
 * Policy is fixed at creation and `updateQueue` refuses to carry it, so a queue that already
 * exists under a different policy keeps it silently — the same "configurable in name only"
 * trap the `updateQueue` call above closes for the retry settings, except this is the setting
 * that *is* the lock. Booting a worker whose per-source lock is not actually a lock is worse
 * than not booting.
 */
async function assertQueuePolicy(boss: PgBoss, name: string): Promise<void> {
  const queue = await boss.getQueue(name);
  if (queue !== null && queue.policy !== INGEST_QUEUE_POLICY) {
    throw new AppError(
      'INGEST_QUEUE_POLICY_DRIFT',
      `Queue "${name}" has policy "${String(queue.policy)}" but the per-source lock requires "${INGEST_QUEUE_POLICY}". Policy cannot be changed after creation — delete the queue and let the next boot recreate it.`,
      { context: { queue: name, actual: queue.policy, expected: INGEST_QUEUE_POLICY } },
    );
  }
}

/**
 * Registers each source's cron, and *unregisters* the ones switched off.
 *
 * The unschedule half is the part that is easy to leave out and expensive to omit: pg-boss
 * keeps schedules in the database, not in this process, so a schedule registered by an
 * earlier boot goes on firing forever after its setting is removed. Without this, switching
 * a source off would appear to work — nothing in the configuration mentions it any more —
 * while the job kept running on the old cadence. Unscheduling something that was never
 * scheduled is a no-op, so this is safe to run on every boot.
 *
 * All schedules live on `INGEST_TICK_QUEUE`, one per source, distinguished by pg-boss's
 * schedule `key`.
 *
 * Applied all-or-nothing. `boss.schedule` is the only thing that can reject a cron this
 * module has already accepted (five legal fields can still be nonsense — `61 * * * *`), and
 * failing partway through the loop would leave the sources it had already reached on the new
 * cadence and the rest silently on the old one, with nothing recording the split. The
 * previous state is captured first and restored on any failure, so a rejected expression
 * leaves the schedule exactly as it was and the worker refuses to boot.
 */
export async function applyIngestSchedules(
  boss: PgBoss,
  scheduler: SchedulerConfig,
): Promise<void> {
  const previous = await boss.getSchedules(INGEST_TICK_QUEUE);
  try {
    for (const source of SOURCES) {
      // Schedules written by an earlier build pointed straight at the source queue. Left
      // alone they would keep firing alongside the tick queue's, double-running the source.
      await boss.unschedule(ingestQueueName(source));

      const cron = scheduler.cron[source];
      if (cron === undefined) {
        await boss.unschedule(INGEST_TICK_QUEUE, source);
        log.info('ingest schedule disabled for source', { source });
        continue;
      }
      // Upserts on (queue, key): re-registering with a different expression replaces the
      // stored one rather than adding a second, so a changed setting takes effect on restart.
      await boss.schedule(INGEST_TICK_QUEUE, cron, { source } satisfies { source: Source }, {
        tz: scheduler.timezone,
        key: source,
      });
      log.info('ingest schedule registered', { source, cron, tz: scheduler.timezone });
    }
  } catch (err) {
    await restoreSchedules(boss, previous);
    throw err;
  }
}

async function restoreSchedules(boss: PgBoss, previous: readonly Schedule[]): Promise<void> {
  const keep = new Set(previous.map((entry) => entry.key));
  for (const source of SOURCES) {
    if (!keep.has(source)) {
      await boss.unschedule(INGEST_TICK_QUEUE, source);
    }
  }
  for (const entry of previous) {
    await boss.schedule(INGEST_TICK_QUEUE, entry.cron, entry.data ?? null, {
      ...entry.options,
      tz: entry.timezone,
      key: entry.key,
    });
  }
  log.warn('ingest schedules rolled back after a rejected expression', {
    restored: previous.map((entry) => ({ key: entry.key, cron: entry.cron })),
  });
}
