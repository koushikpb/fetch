// SPEC I-06 criteria 2 and 3 against a real Postgres, because neither can be established any
// other way: a test that asserts `retryLimit: 3` was handed to pg-boss proves that an option
// was passed, not that a job retries three times and then stops. Everything below either
// starts a real worker and watches what it does, or drives real job-state transitions in the
// database and reads back what pg-boss actually scheduled.
//
// Every Config here has all three schedules switched off, and jobs are sent explicitly. That
// keeps these tests deterministic (no cron firing mid-assertion) and keeps them off the
// network — the only adapters in play are fakes, and the one real registry used is exercised
// through a source that has no adapter at all.
import { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runs as runsTable } from '../../db/schema.js';
import {
  createDrizzleCursorStore,
  createDrizzleDocumentSink,
  createDrizzleIngestRunRecorder,
} from '../../ingest/index.js';
import {
  applyIngestSchedules,
  INGEST_DEAD_LETTER_QUEUE,
  ingestQueueName,
  provisionIngestQueues,
  startIngestWorker,
  type IngestWorker,
} from '../../jobs/index.js';
import { loadConfig, type Config } from '../../lib/config.js';
import { RateLimitError } from '../../lib/errors.js';
import { createRegistry, createSourceRegistry } from '../../sources/registry.js';
import {
  setupScratchDatabase,
  teardownScratchDatabase,
  type ScratchDatabase,
} from '../db/scratch-database.js';
import {
  createFakeAdapter,
  createMemoryCursorStore,
  createMemoryDocumentSink,
  createMemoryRunRecorder,
  parseLogLines,
} from './fakes.js';

const HN_QUEUE = ingestQueueName('hackernews');

/** Every schedule off: these suites send jobs themselves and must not race a cron tick. */
function configFor(connectionString: string, overrides: Record<string, string> = {}): Config {
  return loadConfig({
    DATABASE_URL: connectionString,
    ANTHROPIC_API_KEY: 'placeholder',
    INGEST_SCHEDULE_HACKERNEWS: 'off',
    INGEST_SCHEDULE_APPSTORE: 'off',
    INGEST_SCHEDULE_REDDIT: 'off',
    ...overrides,
  });
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(label: string, predicate: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await sleep(50);
  }
  throw new Error(`timed out after ${String(timeoutMs)}ms waiting for: ${label}`);
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function captureLog(): { lines: () => string[]; restore: () => void } {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  });
  return { lines: () => chunks, restore: () => spy.mockRestore() };
}

// graceful: false throughout — a graceful stop waits out whatever run is in flight, which in
// these suites is a fake adapter deliberately parked on a latch. The graceful path is what
// scripts/worker.ts uses on SIGTERM and is exercised by running the worker for real.
const stopBoss = (boss: PgBoss): Promise<void> =>
  boss.stop({ close: true, graceful: false, timeout: 2000 });

describe('queue provisioning and schedules', () => {
  let scratch: ScratchDatabase;
  let boss: PgBoss;

  beforeAll(async () => {
    scratch = await setupScratchDatabase('jobs_provision');
    // schedule: false — nothing here should be firing cron jobs while assertions run.
    boss = new PgBoss({ connectionString: scratch.connectionString, schedule: false });
    await boss.start();
  }, 60_000);

  afterAll(async () => {
    await stopBoss(boss);
    await teardownScratchDatabase(scratch);
  });

  it('creates one exclusive queue per source, all pointed at the dead letter queue', async () => {
    await provisionIngestQueues(boss, configFor(scratch.connectionString).scheduler);

    for (const source of ['hackernews', 'appstore', 'reddit'] as const) {
      const queue = await boss.getQueue(ingestQueueName(source));
      expect(queue?.policy).toBe('exclusive');
      expect(queue?.deadLetter).toBe(INGEST_DEAD_LETTER_QUEUE);
    }
    expect(await boss.getQueue(INGEST_DEAD_LETTER_QUEUE)).not.toBeNull();
  });

  it('applies changed retry settings on a later boot', async () => {
    // The trap this closes: `createQueue` is a no-op against a queue that already exists, so
    // a provisioner that only created would leave the very first boot's settings in force
    // forever and make INGEST_RETRY_LIMIT configurable in name only. Verified by changing it
    // and re-provisioning exactly as a restart would.
    await provisionIngestQueues(
      boss,
      configFor(scratch.connectionString, {
        INGEST_RETRY_LIMIT: '2',
        INGEST_RETRY_DELAY_SECONDS: '5',
        INGEST_RETRY_DELAY_MAX_SECONDS: '50',
        INGEST_JOB_EXPIRY_SECONDS: '120',
      }).scheduler,
    );
    expect(await boss.getQueue(HN_QUEUE)).toMatchObject({
      retryLimit: 2,
      retryDelay: 5,
      retryBackoff: true,
      retryDelayMax: 50,
      expireInSeconds: 120,
    });

    await provisionIngestQueues(
      boss,
      configFor(scratch.connectionString, {
        INGEST_RETRY_LIMIT: '9',
        INGEST_RETRY_DELAY_SECONDS: '30',
        INGEST_RETRY_DELAY_MAX_SECONDS: '300',
        INGEST_JOB_EXPIRY_SECONDS: '600',
      }).scheduler,
    );
    expect(await boss.getQueue(HN_QUEUE)).toMatchObject({
      retryLimit: 9,
      retryDelay: 30,
      retryDelayMax: 300,
      expireInSeconds: 600,
    });
  });

  it('registers each configured cron and replaces it when the setting changes', async () => {
    await applyIngestSchedules(
      boss,
      configFor(scratch.connectionString, {
        INGEST_SCHEDULE_HACKERNEWS: '*/15 * * * *',
        INGEST_SCHEDULE_APPSTORE: '17 * * * *',
      }).scheduler,
    );
    expect(await boss.getSchedules(HN_QUEUE)).toMatchObject([{ cron: '*/15 * * * *' }]);
    expect(await boss.getSchedules(ingestQueueName('appstore'))).toMatchObject([
      { cron: '17 * * * *' },
    ]);
    // reddit stayed 'off' in this config, so it must not have been scheduled at all.
    expect(await boss.getSchedules(ingestQueueName('reddit'))).toEqual([]);

    // A restart with a changed setting: one schedule, the new expression — not two.
    await applyIngestSchedules(
      boss,
      configFor(scratch.connectionString, { INGEST_SCHEDULE_HACKERNEWS: '*/3 * * * *' }).scheduler,
    );
    const after = await boss.getSchedules(HN_QUEUE);
    expect(after).toHaveLength(1);
    expect(after[0]?.cron).toBe('*/3 * * * *');
    expect(after[0]?.timezone).toBe('UTC');
  });

  it('removes a schedule when its source is switched off', async () => {
    // pg-boss keeps schedules in the database, not in the process, so a boot that merely
    // skipped a disabled source would leave the previous boot's cron firing forever — the
    // setting would appear to have taken effect while the job kept running.
    await applyIngestSchedules(
      boss,
      configFor(scratch.connectionString, { INGEST_SCHEDULE_HACKERNEWS: '*/9 * * * *' }).scheduler,
    );
    expect(await boss.getSchedules(HN_QUEUE)).toHaveLength(1);

    await applyIngestSchedules(boss, configFor(scratch.connectionString).scheduler);
    expect(await boss.getSchedules(HN_QUEUE)).toEqual([]);
  });

  it('honours a non-UTC timezone from configuration', async () => {
    await applyIngestSchedules(
      boss,
      configFor(scratch.connectionString, {
        INGEST_SCHEDULE_APPSTORE: '0 4 * * *',
        INGEST_SCHEDULE_TIMEZONE: 'Europe/London',
      }).scheduler,
    );
    expect(await boss.getSchedules(ingestQueueName('appstore'))).toMatchObject([
      { cron: '0 4 * * *', timezone: 'Europe/London' },
    ]);
  });
});

describe('overlapping runs of one source are prevented by the job-level lock', () => {
  let scratch: ScratchDatabase;
  let worker: IngestWorker;
  const released = deferred();
  let inFlight = 0;
  let maxInFlight = 0;
  let started = 0;

  beforeAll(async () => {
    scratch = await setupScratchDatabase('jobs_lock');
    // Parks inside the run until the latch is released, so a second run has every
    // opportunity to start alongside it if the lock does not hold.
    const adapter = createFakeAdapter({
      source: 'hackernews',
      fetchIncremental: async () => {
        inFlight += 1;
        started += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await released.promise;
        inFlight -= 1;
        return { documents: [], cursor: undefined };
      },
    });
    worker = await startIngestWorker({
      config: configFor(scratch.connectionString),
      context: {
        registry: createSourceRegistry([adapter]),
        documents: createMemoryDocumentSink(),
        cursors: createMemoryCursorStore(),
        runs: createMemoryRunRecorder(),
      },
      pollingIntervalSeconds: 0.5,
    });
  }, 60_000);

  afterAll(async () => {
    released.resolve();
    await stopBoss(worker.boss);
    await teardownScratchDatabase(scratch);
  });

  it('refuses a second run of the same source while one is in flight, from any process', async () => {
    const first = await worker.boss.send(HN_QUEUE, { source: 'hackernews' });
    expect(first).not.toBeNull();
    await waitFor('the first run to be in flight', () => started === 1);

    // A separate PgBoss instance with its own pool — what a second worker *process* looks
    // like. If the lock were an in-process guard rather than a database one, this would win.
    const otherProcess = new PgBoss({
      connectionString: scratch.connectionString,
      schedule: false,
    });
    await otherProcess.start();
    try {
      expect(await otherProcess.send(HN_QUEUE, { source: 'hackernews' })).toBeNull();
      // Nothing for it to pick up either: at most one job per source queue can exist at all,
      // so there is no queued twin waiting to be raced for.
      expect(await otherProcess.fetch(HN_QUEUE, { ignoreStartAfter: true })).toEqual([]);
    } finally {
      await stopBoss(otherProcess);
    }

    // A different source is not blocked — the lock is per source, not per pipeline.
    expect(
      await worker.boss.send(ingestQueueName('appstore'), { source: 'appstore' }),
    ).not.toBeNull();

    // Well past the 0.5s poll interval: if a second run were going to start, it has had
    // several opportunities.
    await sleep(2000);
    expect(started).toBe(1);
    expect(maxInFlight).toBe(1);

    released.resolve();
    await waitFor('the first run to finish', () => inFlight === 0);
  }, 30_000);

  it('lets the next run proceed once the first has finished', async () => {
    const next = await worker.boss.send(HN_QUEUE, { source: 'hackernews' });
    expect(next).not.toBeNull();
    await waitFor('the second run to start', () => started === 2);
    expect(maxInFlight).toBe(1);
  }, 30_000);
});

describe('a failed job retries with backoff and gives up after the configured count', () => {
  let scratch: ScratchDatabase;
  let boss: PgBoss;

  beforeAll(async () => {
    scratch = await setupScratchDatabase('jobs_retry');
    boss = new PgBoss({ connectionString: scratch.connectionString, schedule: false });
    await boss.start();
  }, 60_000);

  afterAll(async () => {
    await stopBoss(boss);
    await teardownScratchDatabase(scratch);
  });

  it('schedules each retry further out than the last, then stops at the configured count', async () => {
    // Drives the real job-state machine but never waits out a backoff: each attempt is
    // fetched with `ignoreStartAfter` and the delay pg-boss actually scheduled is read back
    // from the job's `startAfter`. That is what makes "with backoff" checkable rather than
    // inferred from an option having been set.
    await provisionIngestQueues(
      boss,
      configFor(scratch.connectionString, {
        INGEST_RETRY_LIMIT: '3',
        INGEST_RETRY_DELAY_SECONDS: '4',
        INGEST_RETRY_DELAY_MAX_SECONDS: '3600',
      }).scheduler,
    );
    await boss.send(HN_QUEUE, { source: 'hackernews' });

    const delaysSeconds: number[] = [];
    let attempts = 0;
    for (let i = 0; i < 8; i += 1) {
      const jobs = await boss.fetch(HN_QUEUE, { ignoreStartAfter: true, includeMetadata: true });
      const job = jobs[0];
      if (job === undefined) {
        break;
      }
      attempts += 1;
      const failedAt = Date.now();
      await boss.fail(HN_QUEUE, job.id, { message: 'probe failure' });
      const [after] = await boss.findJobs(HN_QUEUE, { id: job.id });
      if (after?.state === 'retry') {
        delaysSeconds.push((after.startAfter.getTime() - failedAt) / 1000);
      }
    }

    // retryLimit 3 means the first attempt plus three retries, and then no more.
    expect(attempts).toBe(4);
    expect(delaysSeconds).toHaveLength(3);
    for (let i = 1; i < delaysSeconds.length; i += 1) {
      expect(delaysSeconds[i]).toBeGreaterThan(delaysSeconds[i - 1] ?? 0);
    }
    // Not merely increasing — increasing from the configured starting delay.
    expect(delaysSeconds[0]).toBeGreaterThanOrEqual(4);

    const dead = await boss.findJobs(INGEST_DEAD_LETTER_QUEUE, {});
    expect(dead).toHaveLength(1);
    expect(dead[0]?.sourceName).toBe(HN_QUEUE);
    expect(dead[0]?.sourceRetryCount).toBe(3);
  }, 60_000);

  it('caps the backoff at the configured maximum', async () => {
    await provisionIngestQueues(
      boss,
      configFor(scratch.connectionString, {
        INGEST_RETRY_LIMIT: '3',
        INGEST_RETRY_DELAY_SECONDS: '100',
        INGEST_RETRY_DELAY_MAX_SECONDS: '101',
      }).scheduler,
    );
    await boss.send(ingestQueueName('appstore'), { source: 'appstore' });
    const queue = ingestQueueName('appstore');

    const delays: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      const [job] = await boss.fetch(queue, { ignoreStartAfter: true, includeMetadata: true });
      if (job === undefined) {
        break;
      }
      const failedAt = Date.now();
      await boss.fail(queue, job.id, { message: 'probe failure' });
      const [after] = await boss.findJobs(queue, { id: job.id });
      if (after?.state === 'retry') {
        delays.push((after.startAfter.getTime() - failedAt) / 1000);
      }
    }
    expect(delays.length).toBeGreaterThan(0);
    for (const delay of delays) {
      // One second of slack because the delay is measured from a clock reading taken before
      // the `fail` round-trip, not from the instant the database computed `startAfter`.
      // Nowhere near enough slack to hide a missing cap: uncapped, the second retry off a
      // 100-second base is scheduled 100-200 seconds out.
      expect(delay).toBeLessThanOrEqual(102);
    }
  }, 60_000);
});

describe('a worker that keeps failing', () => {
  let scratch: ScratchDatabase;
  let worker: IngestWorker;
  let capture: ReturnType<typeof captureLog>;
  let attempts = 0;

  beforeAll(async () => {
    scratch = await setupScratchDatabase('jobs_giveup');
    const adapter = createFakeAdapter({
      source: 'hackernews',
      fetchIncremental: () => {
        attempts += 1;
        return Promise.reject(new RateLimitError('Hacker News: retries exhausted on 429'));
      },
    });
    worker = await startIngestWorker({
      config: configFor(scratch.connectionString, {
        INGEST_RETRY_LIMIT: '2',
        INGEST_RETRY_DELAY_SECONDS: '1',
        INGEST_RETRY_DELAY_MAX_SECONDS: '4',
      }),
      context: {
        registry: createSourceRegistry([adapter]),
        documents: createMemoryDocumentSink(),
        cursors: createMemoryCursorStore(),
        runs: createMemoryRunRecorder(),
      },
      pollingIntervalSeconds: 0.5,
    });
  }, 60_000);

  afterAll(async () => {
    capture.restore();
    await stopBoss(worker.boss);
    await teardownScratchDatabase(scratch);
  });

  it('retries, gives up at the configured count, and says so at error level', async () => {
    capture = captureLog();
    await worker.boss.send(HN_QUEUE, { source: 'hackernews' });

    const deadLettered = async (): Promise<boolean> =>
      (await worker.boss.findJobs(INGEST_DEAD_LETTER_QUEUE, {})).length > 0;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && !(await deadLettered())) {
      await sleep(100);
    }

    const dead = await worker.boss.findJobs(INGEST_DEAD_LETTER_QUEUE, {});
    expect(dead).toHaveLength(1);
    expect(dead[0]?.sourceName).toBe(HN_QUEUE);
    // The failure reason travels with the give-up rather than being left in a log somewhere.
    expect(JSON.stringify(dead[0]?.output)).toContain('INGEST_RUN_FAILED');

    // retryLimit 2: the original attempt plus two retries. The adapter counts them itself,
    // so this is the number of times the source was actually asked, not a queue statistic.
    expect(attempts).toBe(3);

    // Give up means give up: nothing further is attempted after the dead letter.
    await sleep(3000);
    expect(attempts).toBe(3);

    await waitFor('the give-up to be logged', () =>
      parseLogLines(capture.lines()).some(
        (record) =>
          record.msg === 'scheduled ingest gave up on a source after exhausting its retries' &&
          record.level === 'error',
      ),
    );
    const giveUp = parseLogLines(capture.lines()).find(
      (record) =>
        record.msg === 'scheduled ingest gave up on a source after exhausting its retries',
    );
    expect(giveUp?.source).toBe('hackernews');
    expect(giveUp?.attempts).toBe(3);
    expect(giveUp?.origin_queue).toBe(HN_QUEUE);
  }, 60_000);
});

describe('a source that is configured off', () => {
  let scratch: ScratchDatabase;
  let worker: IngestWorker;

  beforeAll(async () => {
    scratch = await setupScratchDatabase('jobs_skipped');
    const config = configFor(scratch.connectionString);
    worker = await startIngestWorker({
      config,
      context: {
        // The real production registry, built from a Config with no Reddit credentials —
        // which is exactly the state blocker B-09 leaves the deployment in.
        registry: createRegistry(config),
        documents: createDrizzleDocumentSink(scratch.target.db),
        cursors: createDrizzleCursorStore(scratch.target.db),
        runs: createDrizzleIngestRunRecorder(scratch.target.db),
      },
      pollingIntervalSeconds: 0.5,
    });
  }, 60_000);

  afterAll(async () => {
    await stopBoss(worker.boss);
    await teardownScratchDatabase(scratch);
  });

  it('completes its scheduled job without failing or retrying', async () => {
    const jobId = await worker.boss.send(ingestQueueName('reddit'), { source: 'reddit' });
    expect(jobId).not.toBeNull();

    let job = (await worker.boss.findJobs(ingestQueueName('reddit'), { id: jobId ?? '' }))[0];
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && job?.state !== 'completed') {
      await sleep(100);
      job = (await worker.boss.findJobs(ingestQueueName('reddit'), { id: jobId ?? '' }))[0];
    }

    expect(job?.state).toBe('completed');
    // Never retried: an unconfigured source is a settings choice, not a failure.
    expect(job?.retryCount).toBe(0);
    expect(await worker.boss.findJobs(INGEST_DEAD_LETTER_QUEUE, {})).toEqual([]);

    // Quiet is not the same as invisible: the run is on the `runs` table, naming the source
    // and the reason, which is where an operator asking "why is Reddit not ingesting?" looks.
    const rows = await scratch.target.db.select().from(runsTable);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('COMPLETE');
    const bySource = (
      rows[0]?.counts as { bySource?: Record<string, { status?: string; detail?: string }> }
    ).bySource;
    expect(bySource?.reddit?.status).toBe('skipped');
    expect(bySource?.reddit?.detail).toContain('No Reddit credentials configured');
  }, 60_000);
});
