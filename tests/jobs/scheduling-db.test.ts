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
  INGEST_TICK_QUEUE,
  ingestQueueName,
  provisionIngestQueues,
  startIngestWorker,
  type IngestJobContext,
  type IngestWorker,
} from '../../jobs/index.js';
import { loadConfig, type Config } from '../../lib/config.js';
import type { Source } from '../../lib/types.js';
import { AppError, RateLimitError } from '../../lib/errors.js';
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

/** The schedule registered for one source, or undefined when that source is switched off. */
async function scheduleFor(boss: PgBoss, source: Source) {
  return (await boss.getSchedules(INGEST_TICK_QUEUE)).find((entry) => entry.key === source);
}

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
    // Schedules live on the tick queue, one per source, distinguished by `key` — the source
    // queues themselves are never scheduled directly, so that a refused forward is loggable.
    expect(await scheduleFor(boss, 'hackernews')).toMatchObject({ cron: '*/15 * * * *' });
    expect(await scheduleFor(boss, 'appstore')).toMatchObject({ cron: '17 * * * *' });
    // reddit stayed 'off' in this config, so it must not have been scheduled at all.
    expect(await scheduleFor(boss, 'reddit')).toBeUndefined();
    // Nothing may remain pointed straight at a source queue: it would double-run the source.
    expect(await boss.getSchedules(HN_QUEUE)).toEqual([]);

    // A restart with a changed setting: one schedule, the new expression — not two.
    await applyIngestSchedules(
      boss,
      configFor(scratch.connectionString, { INGEST_SCHEDULE_HACKERNEWS: '*/3 * * * *' }).scheduler,
    );
    const all = await boss.getSchedules(INGEST_TICK_QUEUE);
    expect(all.filter((entry) => entry.key === 'hackernews')).toHaveLength(1);
    expect((await scheduleFor(boss, 'hackernews'))?.cron).toBe('*/3 * * * *');
    expect((await scheduleFor(boss, 'hackernews'))?.timezone).toBe('UTC');
  });

  it('removes a schedule when its source is switched off', async () => {
    // pg-boss keeps schedules in the database, not in the process, so a boot that merely
    // skipped a disabled source would leave the previous boot's cron firing forever — the
    // setting would appear to have taken effect while the job kept running.
    await applyIngestSchedules(
      boss,
      configFor(scratch.connectionString, { INGEST_SCHEDULE_HACKERNEWS: '*/9 * * * *' }).scheduler,
    );
    expect(await scheduleFor(boss, 'hackernews')).toBeDefined();

    await applyIngestSchedules(boss, configFor(scratch.connectionString).scheduler);
    expect(await scheduleFor(boss, 'hackernews')).toBeUndefined();
  });

  it('leaves every schedule untouched when one expression is rejected', async () => {
    // `61 * * * *` has five legal fields, so lib/config.ts accepts it by design and only
    // pg-boss rejects it — mid-loop. Without all-or-nothing application, the sources already
    // reached would be left on the new cadence and the rest silently on the old one.
    await applyIngestSchedules(
      boss,
      configFor(scratch.connectionString, {
        INGEST_SCHEDULE_HACKERNEWS: '*/11 * * * *',
        INGEST_SCHEDULE_APPSTORE: '19 * * * *',
        INGEST_SCHEDULE_REDDIT: '39 * * * *',
      }).scheduler,
    );

    await expect(
      applyIngestSchedules(
        boss,
        configFor(scratch.connectionString, {
          INGEST_SCHEDULE_HACKERNEWS: '*/2 * * * *',
          INGEST_SCHEDULE_APPSTORE: '19 * * * *',
          INGEST_SCHEDULE_REDDIT: '61 * * * *',
        }).scheduler,
      ),
    ).rejects.toThrow();

    // hackernews is applied before reddit, so a non-transactional apply would have moved it.
    expect((await scheduleFor(boss, 'hackernews'))?.cron).toBe('*/11 * * * *');
    expect((await scheduleFor(boss, 'appstore'))?.cron).toBe('19 * * * *');
    expect((await scheduleFor(boss, 'reddit'))?.cron).toBe('39 * * * *');
  });

  it('honours a non-UTC timezone from configuration', async () => {
    await applyIngestSchedules(
      boss,
      configFor(scratch.connectionString, {
        INGEST_SCHEDULE_APPSTORE: '0 4 * * *',
        INGEST_SCHEDULE_TIMEZONE: 'Europe/London',
      }).scheduler,
    );
    expect(await scheduleFor(boss, 'appstore')).toMatchObject({
      cron: '0 4 * * *',
      timezone: 'Europe/London',
    });
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
    // Polled rather than sent once: the handler returning is not the same instant as pg-boss
    // settling the job, so a single send here races the completion round-trip and is refused
    // for the correct reason — the lock is still held. What this asserts is that the refusal
    // is temporary, which is the half the previous test cannot show.
    let accepted: string | null = null;
    const deadline = Date.now() + 20_000;
    while (accepted === null && Date.now() < deadline) {
      accepted = await worker.boss.send(HN_QUEUE, { source: 'hackernews' });
      if (accepted === null) {
        await sleep(100);
      }
    }
    expect(accepted).not.toBeNull();
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
    // Compared against a growth factor rather than against the previous element. pg-boss
    // jitters each delay within `[base * 2^n / 2, base * 2^n]`, so consecutive attempts can
    // legitimately land ~1ms apart at the boundary — an assertion that only requires "greater
    // than the last one" passes against a genuine fixed-delay policy on roughly half of runs.
    // Requiring each delay to exceed 1.5x the base separates backoff from no backoff outright.
    for (const delay of delaysSeconds) {
      expect(delay).toBeGreaterThanOrEqual(4);
    }
    expect(delaysSeconds[1]).toBeGreaterThan(4 * 1.5);
    expect(delaysSeconds[2]).toBeGreaterThan(4 * 1.5 * 1.5);

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

describe('a boot that cannot complete', () => {
  let scratch: ScratchDatabase;

  beforeAll(async () => {
    scratch = await setupScratchDatabase('jobs_boot');
  }, 60_000);

  afterAll(async () => {
    await teardownScratchDatabase(scratch);
  });

  function contextFor(): IngestJobContext {
    return {
      registry: createSourceRegistry([createFakeAdapter({ source: 'hackernews' })]),
      documents: createMemoryDocumentSink(),
      cursors: createMemoryCursorStore(),
      runs: createMemoryRunRecorder(),
    };
  }

  // `boss.start()` opens a pool and a set of interval timers. A failure after it that does not
  // stop pg-boss leaves those holding the event loop open, so the process logs the reason and
  // then runs forever without working anything — healthy to a supervisor, ingesting nothing.
  // Both inputs below are ones lib/config.ts accepts by design and pg-boss rejects.
  it('rejects a five-field cron that pg-boss will not accept, and stops pg-boss on the way out', async () => {
    const config = configFor(scratch.connectionString, {
      INGEST_SCHEDULE_HACKERNEWS: '61 * * * *',
    });
    expect(await backendCount(scratch)).toBe(0);

    await expect(startIngestWorker({ config, context: contextFor() })).rejects.toThrow();

    // The throw is the easy half. This is the half that matters: a pg-boss left running holds
    // its connection pool and its interval timers, which keeps the event loop alive, so the
    // process logs the reason and then never exits — a worker that looks healthy to a
    // supervisor and ingests nothing. Counting backends is what distinguishes "reported the
    // error" from "reported the error and let go".
    expect(await backendCount(scratch)).toBe(0);
  }, 60_000);

  it('rejects an expiry pg-boss asserts on, at config boot rather than inside the dependency', () => {
    // 86400 is exactly the ceiling pg-boss refuses; the previous build accepted any integer
    // >= 1 here and only found out during createQueue.
    expect(() =>
      configFor(scratch.connectionString, { INGEST_JOB_EXPIRY_SECONDS: '86400' }),
    ).toThrow(/INGEST_JOB_EXPIRY_SECONDS must be an integer no greater than 86399/);
    expect(() => configFor(scratch.connectionString, { INGEST_JOB_EXPIRY_SECONDS: '1' })).toThrow(
      /INGEST_JOB_EXPIRY_SECONDS must be an integer of at least 60/,
    );
  });

  it('refuses to boot when a source queue exists under a policy that is not the lock', async () => {
    // Policy is fixed at creation and `updateQueue` refuses to carry it, so this is the one
    // setting re-provisioning cannot repair. Booting anyway would mean a worker whose
    // per-source lock silently is not a lock.
    //
    // Its own database: the drifted queue has to pre-date any successful provisioning, and
    // `createQueue` is a no-op against a queue that already exists — which is the whole reason
    // this check has to read the policy back rather than trust the create.
    const drifted = await setupScratchDatabase('jobs_policy');
    try {
      const boss = new PgBoss({ connectionString: drifted.connectionString, schedule: false });
      await boss.start();
      await boss.createQueue(ingestQueueName('appstore'), { policy: 'standard' });
      await stopBoss(boss);

      await expect(
        startIngestWorker({ config: configFor(drifted.connectionString), context: contextFor() }),
      ).rejects.toMatchObject({ code: 'INGEST_QUEUE_POLICY_DRIFT' });
    } finally {
      await teardownScratchDatabase(drifted);
    }
  }, 90_000);
});

/**
 * How many backends are connected to the scratch database. Counted from the admin connection,
 * which is attached to a different database, so nothing here contributes to its own reading.
 */
async function backendCount(scratch: ScratchDatabase): Promise<number> {
  const { rows } = await scratch.admin.query<{ n: number }>(
    'select count(*)::int as n from pg_stat_activity where datname = $1',
    [scratch.databaseName],
  );
  return rows[0]?.n ?? 0;
}

describe('a worker killed mid-run', () => {
  let scratch: ScratchDatabase;
  let boss: PgBoss;

  beforeAll(async () => {
    scratch = await setupScratchDatabase('jobs_orphan');
    // Both intervals shortened so the suite observes in seconds what production does in about
    // two minutes: reclaim latency is heartbeatSeconds plus the supervisor's monitor interval.
    boss = new PgBoss({
      connectionString: scratch.connectionString,
      schedule: false,
      superviseIntervalSeconds: 5,
      monitorIntervalSeconds: 5,
      queueCacheIntervalSeconds: 5,
    });
    await boss.start();
  }, 60_000);

  afterAll(async () => {
    await stopBoss(boss);
    await teardownScratchDatabase(scratch);
  });

  it('has its orphaned job reclaimed instead of locking the source out until expiry', async () => {
    // `kill -9` mid-run leaves the job `active` with nobody to settle it. Under the exclusive
    // policy that locked the source out completely — every later send refused, nothing logged
    // — until `expireInSeconds`, an hour by default. `heartbeatSeconds` is what bounds it: the
    // worker refreshes the heartbeat while a handler runs, so a dead worker's stops.
    await provisionIngestQueues(boss, configFor(scratch.connectionString).scheduler);
    const queue = ingestQueueName('hackernews');

    // The production queues really do carry a heartbeat — without this the reclaim below
    // would be proving something about a queue this code does not actually create.
    expect((await boss.getQueue(queue))?.heartbeatSeconds).toBe(60);
    // Shortened for the behavioural half only. Reclaim latency is heartbeatSeconds plus the
    // supervisor's monitor interval, so at the production value this test would idle for over
    // a minute to observe a mechanism that does not depend on the constant. The 60-second
    // value itself is asserted above, and exercised end to end by the live kill -9 in the
    // report.
    await boss.updateQueue(queue, { heartbeatSeconds: 10 });

    await boss.send(queue, { source: 'hackernews' });
    const [orphan] = await boss.fetch(queue);
    expect(orphan).toBeDefined();
    // The lockout is real while the orphan is held: this is the state the old build stayed in.
    expect(await boss.send(queue, { source: 'hackernews' })).toBeNull();

    const deadline = Date.now() + 45_000;
    let state: string | undefined;
    while (Date.now() < deadline) {
      state = (await boss.findJobs(queue, { id: orphan?.id ?? '' }))[0]?.state;
      if (state !== 'active') {
        break;
      }
      await sleep(250);
    }
    // Back to `retry`, which means a live worker will pick it up and the source runs again.
    expect(state).toBe('retry');
  }, 90_000);

  it('leaves the orphan stuck when no heartbeat is configured — the behaviour being fixed', async () => {
    // The control. Same orphaning, same wait, no heartbeat: still `active`, still locked out.
    // Without this the test above would pass just as well against a queue pg-boss happened to
    // reclaim for some other reason.
    await boss.createQueue('ingest.no-heartbeat', { policy: 'exclusive', expireInSeconds: 3600 });
    await boss.send('ingest.no-heartbeat', { source: 'hackernews' });
    const [orphan] = await boss.fetch('ingest.no-heartbeat');

    await sleep(20_000);

    const state = (await boss.findJobs('ingest.no-heartbeat', { id: orphan?.id ?? '' }))[0]?.state;
    expect(state).toBe('active');
    expect(await boss.send('ingest.no-heartbeat', {})).toBeNull();
  }, 90_000);
});

describe('a tick that arrives while the source is already busy', () => {
  let scratch: ScratchDatabase;
  let worker: IngestWorker;
  let capture: ReturnType<typeof captureLog>;
  const released = deferred();
  let started = 0;

  beforeAll(async () => {
    scratch = await setupScratchDatabase('jobs_tick');
    const adapter = createFakeAdapter({
      source: 'hackernews',
      fetchIncremental: async () => {
        started += 1;
        await released.promise;
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
    capture.restore();
    released.resolve();
    await stopBoss(worker.boss);
    await teardownScratchDatabase(scratch);
  });

  it('is dropped and says so, rather than vanishing', async () => {
    // pg-boss's own scheduler forwards ticks with `manager.send` and re-emits only *rejected*
    // sends; an exclusive-policy refusal resolves to `null`, so scheduling straight onto the
    // source queue made a dropped tick produce no line at any level. Ticks are routed through
    // a queue this code owns precisely so the `null` has somewhere to be reported.
    capture = captureLog();
    await worker.boss.send(INGEST_TICK_QUEUE, { source: 'hackernews' });
    await waitFor('the first run to be in flight', () => started === 1);

    await worker.boss.send(INGEST_TICK_QUEUE, { source: 'hackernews' });
    await waitFor('the dropped tick to be logged', () =>
      parseLogLines(capture.lines()).some(
        (record) =>
          record.msg === 'scheduled ingest tick dropped: a run of this source is already pending',
      ),
    );

    const dropped = parseLogLines(capture.lines()).find(
      (record) =>
        record.msg === 'scheduled ingest tick dropped: a run of this source is already pending',
    );
    expect(dropped?.level).toBe('warn');
    expect(dropped?.source).toBe('hackernews');
    // Dropped, not queued: the second tick never became a second run.
    expect(started).toBe(1);
  }, 60_000);
});

describe('error paths that would otherwise be silent', () => {
  let scratch: ScratchDatabase;
  let boss: PgBoss;

  beforeAll(async () => {
    scratch = await setupScratchDatabase('jobs_silent');
    boss = new PgBoss({ connectionString: scratch.connectionString, schedule: false });
    await boss.start();
    await provisionIngestQueues(boss, configFor(scratch.connectionString).scheduler);
  }, 60_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    await stopBoss(boss);
    await teardownScratchDatabase(scratch);
  });

  it('logs at error when a tick cannot be dispatched at all', async () => {
    // The refused forward returns `null` and is covered elsewhere. This is the throwing one:
    // with `retryLimit: 0` and no dead letter on the tick queue, the failure would otherwise
    // exist only in `pgboss.job.output` — no line at any level, nothing to alert on.
    const worker = await startIngestWorker({
      config: configFor(scratch.connectionString),
      context: {
        registry: createSourceRegistry([createFakeAdapter({ source: 'hackernews' })]),
        documents: createMemoryDocumentSink(),
        cursors: createMemoryCursorStore(),
        runs: createMemoryRunRecorder(),
      },
      pollingIntervalSeconds: 0.5,
    });
    const capture = captureLog();
    try {
      // Selective: the forward the dispatcher makes onto the source queue fails, while this
      // test's own enqueue onto the tick queue still has to work.
      const realSend = worker.boss.send.bind(worker.boss);
      vi.spyOn(worker.boss, 'send').mockImplementation(
        async (...args: Parameters<typeof realSend>) => {
          if (args[0] === ingestQueueName('hackernews')) {
            throw new Error('SIMULATED send failure');
          }
          return realSend(...args);
        },
      );

      await worker.boss.send(INGEST_TICK_QUEUE, { source: 'hackernews' });

      await waitFor('the failed dispatch to be logged', () =>
        parseLogLines(capture.lines()).some(
          (record) => record.msg === 'scheduled ingest tick could not be dispatched',
        ),
      );
      const failure = parseLogLines(capture.lines()).find(
        (record) => record.msg === 'scheduled ingest tick could not be dispatched',
      );
      expect(failure?.level).toBe('error');
      expect(failure?.source).toBe('hackernews');
      expect(JSON.stringify(failure?.error)).toContain('SIMULATED send failure');
    } finally {
      capture.restore();
      vi.restoreAllMocks();
      await stopBoss(worker.boss);
    }
  }, 60_000);

  it('keeps the original failure when the rollback itself fails', async () => {
    // Bare propagation of the rollback error replaced "your cron says 61" with "the restore
    // failed" — and the rejected expression lives in a file only the operator can see, so it
    // is the one detail unrecoverable from anywhere else.
    await applyIngestSchedules(
      boss,
      configFor(scratch.connectionString, {
        INGEST_SCHEDULE_HACKERNEWS: '*/11 * * * *',
        INGEST_SCHEDULE_APPSTORE: '19 * * * *',
        INGEST_SCHEDULE_REDDIT: '39 * * * *',
      }).scheduler,
    );

    // The apply loop schedules hackernews, appstore, then throws on reddit's `61`. Everything
    // after that third call belongs to the rollback, so failing from the fourth call onward
    // simulates a restore that cannot complete.
    const real = boss.schedule.bind(boss);
    let calls = 0;
    vi.spyOn(boss, 'schedule').mockImplementation(async (...args: Parameters<typeof real>) => {
      calls += 1;
      if (calls >= 4) {
        throw new Error('SIMULATED restore failure');
      }
      return real(...args);
    });

    const error: unknown = await applyIngestSchedules(
      boss,
      configFor(scratch.connectionString, {
        INGEST_SCHEDULE_HACKERNEWS: '*/2 * * * *',
        INGEST_SCHEDULE_APPSTORE: '19 * * * *',
        INGEST_SCHEDULE_REDDIT: '61 * * * *',
      }).scheduler,
    ).catch((e: unknown) => e);
    vi.restoreAllMocks();

    expect(error).toBeInstanceOf(AppError);
    const appError = error as AppError;
    expect(appError.code).toBe('INGEST_SCHEDULE_ROLLBACK_FAILED');
    // Both, in the message itself: scripts/worker.ts prints an AppError's own message without
    // walking `cause`, so an original reachable only via `cause` would never be seen.
    expect(appError.message).toContain('61');
    expect(appError.message).toContain('SIMULATED restore failure');
    // And still attached for anything reading it programmatically.
    expect((appError.cause as Error).message).toContain('61');
  }, 60_000);

  it('rolls back legacy per-source schedules too, not just the tick queue', async () => {
    // The upgrade path. A round-0 deployment has schedules on the source queues; this
    // function unschedules them, so leaving them out of the snapshot meant a single bad cron
    // on the upgrade boot destroyed every schedule and "restored" an empty set.
    for (const source of ['hackernews', 'appstore', 'reddit'] as const) {
      await boss.schedule(ingestQueueName(source), '*/7 * * * *', null, { tz: 'UTC' });
    }
    await boss.unschedule(INGEST_TICK_QUEUE, 'hackernews');
    await boss.unschedule(INGEST_TICK_QUEUE, 'appstore');
    await boss.unschedule(INGEST_TICK_QUEUE, 'reddit');

    await expect(
      applyIngestSchedules(
        boss,
        configFor(scratch.connectionString, { INGEST_SCHEDULE_REDDIT: '61 * * * *' }).scheduler,
      ),
    ).rejects.toThrow();

    // The legacy deployment's schedules survive: a co-running old worker keeps ticking.
    for (const source of ['hackernews', 'appstore', 'reddit'] as const) {
      const legacy = await boss.getSchedules(ingestQueueName(source));
      expect(legacy).toMatchObject([{ cron: '*/7 * * * *' }]);
    }
    // Cleaned up so the next test starts from a known state.
    for (const source of ['hackernews', 'appstore', 'reddit'] as const) {
      await boss.unschedule(ingestQueueName(source));
    }
  }, 60_000);

  it('treats an unreadable queue as policy drift rather than a pass', async () => {
    // `null` means the policy is unknown, and unknown is what this check exists to refuse —
    // skipping the assertion made the one unreadable case the one case that passed.
    vi.spyOn(boss, 'getQueue').mockResolvedValue(null);
    try {
      await expect(
        provisionIngestQueues(boss, configFor(scratch.connectionString).scheduler),
      ).rejects.toMatchObject({ code: 'INGEST_QUEUE_POLICY_DRIFT' });
    } finally {
      vi.restoreAllMocks();
    }
  }, 60_000);
});
