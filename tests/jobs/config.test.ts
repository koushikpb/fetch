// SPEC I-06 criterion 1 ("schedules are configuration, not code") at the settings layer:
// every knob below is reachable from the environment, so changing when a source runs takes
// an edit to `.env` and a restart, never an edit to a `.ts` file.
//
// What this file does NOT prove: that a registered schedule actually fires, or that a
// changed cron replaces the one already stored in the database. Both are behaviour rather
// than parsing, and both are proved against a real Postgres in scheduling-db.test.ts.
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../lib/config.js';
import { ConfigError } from '../../lib/errors.js';

const BASE_ENV: Record<string, string | undefined> = {
  DATABASE_URL: 'postgres://user@localhost:5432/fetch_test',
  ANTHROPIC_API_KEY: 'placeholder',
};

function load(overrides: Record<string, string | undefined> = {}) {
  return loadConfig({ ...BASE_ENV, ...overrides });
}

function messageFor(overrides: Record<string, string | undefined>): string {
  try {
    load(overrides);
  } catch (err) {
    if (err instanceof ConfigError) {
      return err.message;
    }
    throw err;
  }
  return '';
}

describe('scheduler configuration', () => {
  it('defaults every source to its own cadence rather than one shared interval', () => {
    const { scheduler } = load();
    expect(scheduler.cron).toEqual({
      hackernews: '*/15 * * * *',
      appstore: '17 * * * *',
      reddit: '37 * * * *',
    });
    // Distinct minutes: three sources on the same tick contend for nothing useful.
    const minutes = Object.values(scheduler.cron).map((cron) => cron?.split(' ')[0]);
    expect(new Set(minutes).size).toBe(3);
  });

  it('defaults the retry policy to a bounded, backing-off one', () => {
    const { scheduler } = load();
    expect(scheduler.retryLimit).toBe(3);
    expect(scheduler.retryDelaySeconds).toBe(60);
    expect(scheduler.retryDelayMaxSeconds).toBe(900);
    expect(scheduler.jobExpirySeconds).toBe(3600);
    expect(scheduler.timezone).toBe('UTC');
  });

  it('takes each source cadence from its own environment variable', () => {
    const { scheduler } = load({
      INGEST_SCHEDULE_HACKERNEWS: '*/2 * * * *',
      INGEST_SCHEDULE_APPSTORE: '0 */6 * * *',
      INGEST_SCHEDULE_REDDIT: '0 3 * * 1-5',
    });
    expect(scheduler.cron.hackernews).toBe('*/2 * * * *');
    expect(scheduler.cron.appstore).toBe('0 */6 * * *');
    expect(scheduler.cron.reddit).toBe('0 3 * * 1-5');
  });

  it('takes the retry policy and timezone from the environment', () => {
    const { scheduler } = load({
      INGEST_RETRY_LIMIT: '5',
      INGEST_RETRY_DELAY_SECONDS: '10',
      INGEST_RETRY_DELAY_MAX_SECONDS: '120',
      INGEST_JOB_EXPIRY_SECONDS: '600',
      INGEST_SCHEDULE_TIMEZONE: 'Europe/London',
    });
    expect(scheduler.retryLimit).toBe(5);
    expect(scheduler.retryDelaySeconds).toBe(10);
    expect(scheduler.retryDelayMaxSeconds).toBe(120);
    expect(scheduler.jobExpirySeconds).toBe(600);
    expect(scheduler.timezone).toBe('Europe/London');
  });

  it('treats "off" as switched off, distinctly from unset', () => {
    for (const value of ['off', 'OFF', '  Off  ']) {
      expect(load({ INGEST_SCHEDULE_APPSTORE: value }).scheduler.cron.appstore).toBeUndefined();
    }
    // Unset is *not* off — it takes the default, which is what keeps a source running when
    // nobody has expressed an opinion about it.
    expect(load({}).scheduler.cron.appstore).toBe('17 * * * *');
  });

  it('rejects a cron with the wrong number of fields', () => {
    // The load-bearing case: pg-boss's own parser accepts a four-field expression without
    // complaint (verified against pg-boss 12.27.0), so nothing downstream catches this and a
    // schedule would quietly fire at times nobody intended.
    expect(messageFor({ INGEST_SCHEDULE_HACKERNEWS: '*/5 * * *' })).toContain(
      'INGEST_SCHEDULE_HACKERNEWS must be a five-field cron expression',
    );
    expect(messageFor({ INGEST_SCHEDULE_HACKERNEWS: '0 * * * * *' })).toContain(
      'INGEST_SCHEDULE_HACKERNEWS must be a five-field cron expression',
    );
    expect(messageFor({ INGEST_SCHEDULE_REDDIT: 'hourly' })).toContain(
      'INGEST_SCHEDULE_REDDIT must be a five-field cron expression',
    );
  });

  it('accepts the cron shapes a schedule is realistically written in', () => {
    for (const cron of ['*/15 * * * *', '0 0 * * *', '0,30 9-17 * * MON-FRI', '17 * * * *']) {
      expect(load({ INGEST_SCHEDULE_APPSTORE: cron }).scheduler.cron.appstore).toBe(cron);
    }
  });

  it('rejects a timezone that is not a real zone', () => {
    // Also unchecked downstream: pg-boss accepted 'Not/AZone' without complaint.
    expect(messageFor({ INGEST_SCHEDULE_TIMEZONE: 'Not/AZone' })).toContain(
      'INGEST_SCHEDULE_TIMEZONE must be an IANA time zone name',
    );
  });

  it('allows a retry limit of zero but rejects a negative or fractional one', () => {
    // Zero is "attempt once, never retry" — a legitimate choice, not a mistake.
    expect(load({ INGEST_RETRY_LIMIT: '0' }).scheduler.retryLimit).toBe(0);
    expect(messageFor({ INGEST_RETRY_LIMIT: '-1' })).toContain(
      'INGEST_RETRY_LIMIT must be an integer of at least 0',
    );
    expect(messageFor({ INGEST_RETRY_LIMIT: '2.5' })).toContain(
      'INGEST_RETRY_LIMIT must be an integer of at least 0',
    );
    expect(messageFor({ INGEST_RETRY_LIMIT: 'many' })).toContain(
      'INGEST_RETRY_LIMIT must be an integer of at least 0',
    );
  });

  it('rejects intervals that are not intervals', () => {
    expect(messageFor({ INGEST_RETRY_DELAY_SECONDS: '0' })).toContain(
      'INGEST_RETRY_DELAY_SECONDS must be an integer of at least 1',
    );
    expect(messageFor({ INGEST_JOB_EXPIRY_SECONDS: '0' })).toContain(
      'INGEST_JOB_EXPIRY_SECONDS must be an integer of at least 1',
    );
  });

  it('rejects a maximum backoff below the initial delay, which would not be backoff', () => {
    expect(
      messageFor({ INGEST_RETRY_DELAY_SECONDS: '120', INGEST_RETRY_DELAY_MAX_SECONDS: '30' }),
    ).toContain('INGEST_RETRY_DELAY_MAX_SECONDS must be greater than or equal to');
    // Equal is fine: a deliberate fixed delay is a choice, an accidental one is the bug.
    expect(
      load({ INGEST_RETRY_DELAY_SECONDS: '30', INGEST_RETRY_DELAY_MAX_SECONDS: '30' }).scheduler
        .retryDelayMaxSeconds,
    ).toBe(30);
  });

  it('reports every scheduling problem in one boot, not one per restart', () => {
    const message = messageFor({
      INGEST_SCHEDULE_HACKERNEWS: 'nightly',
      INGEST_SCHEDULE_REDDIT: '* * * *',
      INGEST_SCHEDULE_TIMEZONE: 'Mars/Olympus',
      INGEST_RETRY_LIMIT: '-4',
    });
    expect(message).toContain('INGEST_SCHEDULE_HACKERNEWS');
    expect(message).toContain('INGEST_SCHEDULE_REDDIT');
    expect(message).toContain('INGEST_SCHEDULE_TIMEZONE');
    expect(message).toContain('INGEST_RETRY_LIMIT');
  });

  it('holds no secret, so it survives an enumeration of the config', () => {
    const config = load({ INGEST_SCHEDULE_HACKERNEWS: '*/3 * * * *' });
    const enumerated = JSON.parse(JSON.stringify(config)) as {
      scheduler: { cron: Record<string, string> };
    };
    expect(enumerated.scheduler.cron.hackernews).toBe('*/3 * * * *');
  });
});
