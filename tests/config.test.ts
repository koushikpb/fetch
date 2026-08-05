// Proves SPEC F-03's three criteria against real behaviour rather than code inspection:
// (1) a missing required variable fails boot, non-zero, naming the variable; (2) is proved
// in tests/eslint-rules.test.ts (a lint rule, not runtime behaviour) — not duplicated here;
// (3) secrets never survive the serialization routes listed in the task brief. Criterion 3
// is proved with a distinctive sentinel value (SECRET_SENTINEL) run through every route and
// asserted absent by substring match — the brief's own warning that "intending not to log
// secrets" is not sufficient is exactly why these are behavioural assertions, not a read of
// the redaction code.
import { inspect } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigError } from '../lib/errors.js';
import { log } from '../lib/log.js';
import { bootConfig, loadConfig, loadConfigFromEnv } from '../lib/config.js';

// Distinctive enough that a substring match proves something — a generic value like
// "secret" or "password" could plausibly appear in a field name, error message, or this
// file's own prose and produce a false pass.
const SECRET_SENTINEL = 'zQ7-SENTINEL-DO-NOT-LEAK-4f2b9c';

const MINIMAL_VALID_ENV = {
  DATABASE_URL: 'postgresql://user:pw@localhost:5432/fetch_test',
  ANTHROPIC_API_KEY: 'sk-ant-test-key',
};

const FULL_VALID_ENV = {
  DATABASE_URL: 'postgres://user:pw@localhost:5432/fetch_test',
  ANTHROPIC_API_KEY: 'sk-ant-test-key',
  REDDIT_CLIENT_ID: 'reddit-client-id',
  REDDIT_CLIENT_SECRET: 'reddit-client-secret',
  REDDIT_USER_AGENT: 'fetch-app/0.1 (by /u/example)',
  BUDGET_CEILING_USD: '42.5',
  LOG_LEVEL: 'debug',
  NODE_ENV: 'production',
};

// `expect(fn).toThrow(...)` alone can't hand back the caught value for inspecting multiple
// properties (message, context, stack) on the same error, so this captures it once instead
// of relying on a non-existent "unreachable after throw" assertion.
function catchError(fn: () => unknown): unknown {
  try {
    fn();
    return undefined;
  } catch (err) {
    return err;
  }
}

// Shared by both the "secret redaction" describe block and the fix-round-1 "own-property
// enumeration" block below — a `Config` whose four secret fields all carry the sentinel,
// plus a real (non-secret) Reddit user agent, so the "still visible" assertions on that
// field mean something too.
function configWithSentinel(): ReturnType<typeof loadConfig> {
  return loadConfig({
    DATABASE_URL: `postgresql://user:${SECRET_SENTINEL}@localhost:5432/db`,
    ANTHROPIC_API_KEY: SECRET_SENTINEL,
    REDDIT_CLIENT_ID: SECRET_SENTINEL,
    REDDIT_CLIENT_SECRET: SECRET_SENTINEL,
    REDDIT_USER_AGENT: 'fetch-app/0.1 (by /u/example)',
  });
}

function captureStdoutWrites(): { text: () => string; restore: () => void } {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  });
  return { text: () => chunks.join(''), restore: () => spy.mockRestore() };
}

describe('loadConfig — required variables (criterion 1)', () => {
  it('accepts a minimal valid env and applies documented defaults', () => {
    const config = loadConfig(MINIMAL_VALID_ENV);
    expect(config.databaseUrl).toBe(MINIMAL_VALID_ENV.DATABASE_URL);
    expect(config.anthropicApiKey).toBe(MINIMAL_VALID_ENV.ANTHROPIC_API_KEY);
    expect(config.reddit).toBeUndefined();
    expect(config.budgetCeilingUsd).toBe(70);
    expect(config.logLevel).toBe('info');
    expect(config.nodeEnv).toBe('development');
  });

  it('accepts a fully populated env, including the optional Reddit trio', () => {
    const config = loadConfig(FULL_VALID_ENV);
    // Asserted field-by-field via direct property access, not `toEqual` against a plain
    // object literal — `clientId`/`clientSecret` are deliberately non-enumerable (fix
    // round 1, Finding 1), so `toEqual` silently ignores them rather than comparing them;
    // reading the property directly is the actual contract being proved here.
    expect(config.reddit?.clientId).toBe('reddit-client-id');
    expect(config.reddit?.clientSecret).toBe('reddit-client-secret');
    expect(config.reddit?.userAgent).toBe('fetch-app/0.1 (by /u/example)');
    expect(config.budgetCeilingUsd).toBe(42.5);
    expect(config.logLevel).toBe('debug');
    expect(config.nodeEnv).toBe('production');
  });

  it('throws ConfigError naming DATABASE_URL when it is missing', () => {
    const env = { ...MINIMAL_VALID_ENV, DATABASE_URL: undefined };
    expect(() => loadConfig(env)).toThrow(ConfigError);
    expect(() => loadConfig(env)).toThrow(/DATABASE_URL/);
  });

  it('throws ConfigError naming ANTHROPIC_API_KEY when it is missing', () => {
    const env = { ...MINIMAL_VALID_ENV, ANTHROPIC_API_KEY: undefined };
    expect(() => loadConfig(env)).toThrow(/ANTHROPIC_API_KEY/);
  });

  it('treats an empty string the same as a missing required variable', () => {
    const env = { ...MINIMAL_VALID_ENV, DATABASE_URL: '' };
    expect(() => loadConfig(env)).toThrow(/DATABASE_URL/);
  });

  it('rejects a DATABASE_URL that is not a postgres:// or postgresql:// URL', () => {
    const env = { ...MINIMAL_VALID_ENV, DATABASE_URL: 'mysql://user:pw@localhost:3306/db' };
    expect(() => loadConfig(env)).toThrow(/DATABASE_URL/);
  });

  it('reports every missing/invalid variable in one thrown error, not just the first', () => {
    const env = {
      DATABASE_URL: undefined,
      ANTHROPIC_API_KEY: undefined,
      REDDIT_CLIENT_ID: 'only-one-of-three',
    };
    const thrown = catchError(() => loadConfig(env));
    expect(thrown).toBeInstanceOf(ConfigError);
    const message = (thrown as ConfigError).message;
    expect(message).toMatch(/DATABASE_URL/);
    expect(message).toMatch(/ANTHROPIC_API_KEY/);
    expect(message).toMatch(/REDDIT_CLIENT_ID/);
    expect(message).toMatch(/REDDIT_CLIENT_SECRET/);
  });

  it('exits non-zero via process.exit(1) when required variables are missing', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((): never => {
      throw new Error('process.exit called');
    });
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.stubEnv('DATABASE_URL', undefined);
    vi.stubEnv('ANTHROPIC_API_KEY', undefined);

    expect(() => bootConfig()).toThrow('process.exit called');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(stderrSpy.mock.calls.some((call) => String(call[0]).includes('DATABASE_URL'))).toBe(
      true,
    );

    exitSpy.mockRestore();
    stderrSpy.mockRestore();
    vi.unstubAllEnvs();
  });
});

describe('Reddit trio (all-or-nothing)', () => {
  it('leaves reddit undefined when none of the three are set', () => {
    expect(loadConfig(MINIMAL_VALID_ENV).reddit).toBeUndefined();
  });

  it('rejects REDDIT_CLIENT_ID alone', () => {
    const env = { ...MINIMAL_VALID_ENV, REDDIT_CLIENT_ID: 'only-id' };
    expect(() => loadConfig(env)).toThrow(
      /REDDIT_CLIENT_ID.*REDDIT_CLIENT_SECRET.*REDDIT_USER_AGENT/s,
    );
  });

  it('rejects REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET without REDDIT_USER_AGENT', () => {
    const env = {
      ...MINIMAL_VALID_ENV,
      REDDIT_CLIENT_ID: 'id',
      REDDIT_CLIENT_SECRET: 'secret',
    };
    expect(() => loadConfig(env)).toThrow(/REDDIT_USER_AGENT/);
  });

  it('accepts all three present together', () => {
    const env = {
      ...MINIMAL_VALID_ENV,
      REDDIT_CLIENT_ID: 'id',
      REDDIT_CLIENT_SECRET: 'secret',
      REDDIT_USER_AGENT: 'ua',
    };
    // Field-by-field, not `toEqual` — see the comment on the equivalent assertion above.
    const reddit = loadConfig(env).reddit;
    expect(reddit?.clientId).toBe('id');
    expect(reddit?.clientSecret).toBe('secret');
    expect(reddit?.userAgent).toBe('ua');
  });
});

// I-05 composer resolution 2: the registry became config-aware, so lib/config.ts grew the
// settings the three adapters need. The governing rule for all of them is that `undefined`
// means "not configured" and leaves the adapter's own default in force — this file never
// restates an adapter default, so the two cannot drift apart.
describe('adapter settings (I-05)', () => {
  const REDDIT_CREDENTIALS = {
    REDDIT_CLIENT_ID: 'id',
    REDDIT_CLIENT_SECRET: 'secret',
    REDDIT_USER_AGENT: 'ua',
  };

  it('leaves every adapter setting undefined when nothing is configured', () => {
    const config = loadConfig(MINIMAL_VALID_ENV);
    expect(config.hackernews.queries).toBeUndefined();
    expect(config.appstore.appIds).toBeUndefined();
    expect(config.appstore.territories).toBeUndefined();
  });

  it('parses comma-separated lists, trimming whitespace and dropping empty entries', () => {
    const config = loadConfig({
      ...MINIMAL_VALID_ENV,
      HN_QUERIES: 'postgres, pgvector ,,',
      APPSTORE_APP_IDS: '284910350,570060128',
      APPSTORE_TERRITORIES: ' us , gb ',
    });
    expect(config.hackernews.queries).toEqual(['postgres', 'pgvector']);
    expect(config.appstore.appIds).toEqual(['284910350', '570060128']);
    expect(config.appstore.territories).toEqual(['us', 'gb']);
  });

  it('treats an empty or separator-only list as unconfigured rather than as an empty sweep', () => {
    const config = loadConfig({ ...MINIMAL_VALID_ENV, HN_QUERIES: ' , , ' });
    expect(config.hackernews.queries).toBeUndefined();
  });

  it('carries Reddit’s subreddits and comment threshold alongside its credentials', () => {
    const config = loadConfig({
      ...MINIMAL_VALID_ENV,
      ...REDDIT_CREDENTIALS,
      REDDIT_SUBREDDITS: 'selfhosted,smallbusiness',
      REDDIT_MIN_COMMENTS_TO_EXPAND: '12',
    });
    expect(config.reddit?.subreddits).toEqual(['selfhosted', 'smallbusiness']);
    expect(config.reddit?.minCommentsToExpand).toBe(12);
  });

  // Fix round 1, Finding 5: Reddit settings without Reddit credentials used to be a boot
  // error, which took Hacker News and App Store ingestion down with it over a setting that
  // affects neither. It is a warning now — the run row already records the Reddit skip and
  // its reason, so the information was never actually lost.
  it('does not reject Reddit settings configured without credentials', () => {
    const config = loadConfig({
      ...MINIMAL_VALID_ENV,
      REDDIT_SUBREDDITS: 'selfhosted',
      REDDIT_MIN_COMMENTS_TO_EXPAND: '5',
    });
    expect(config.reddit).toBeUndefined();
    // The other two sources are entirely unaffected, which is the whole point of relaxing it.
    expect(config.databaseUrl).toBe(MINIMAL_VALID_ENV.DATABASE_URL);
  });

  it('warns at boot — naming the variables, never their values — when they cannot be used', () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://stub:stub@localhost:5432/stub_db');
    vi.stubEnv('ANTHROPIC_API_KEY', 'stub-anthropic-key');
    vi.stubEnv('REDDIT_SUBREDDITS', 'selfhosted,smallbusiness');
    vi.stubEnv('REDDIT_CLIENT_ID', undefined);
    vi.stubEnv('REDDIT_CLIENT_SECRET', undefined);
    vi.stubEnv('REDDIT_USER_AGENT', undefined);

    const capture = captureStdoutWrites();
    const config = bootConfig();
    capture.restore();

    expect(config.reddit).toBeUndefined();
    const written = capture.text();
    expect(written).toContain('REDDIT_SUBREDDITS');
    expect(written).toContain('"level":"warn"');
    // Names, not values — REDDIT_SUBREDDITS is not itself a secret but it sits beside two
    // that are, and the boot path should not start printing env values.
    expect(written).not.toContain('smallbusiness');
    vi.unstubAllEnvs();
  });

  it('stays silent at boot when the settings are usable', () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://stub:stub@localhost:5432/stub_db');
    vi.stubEnv('ANTHROPIC_API_KEY', 'stub-anthropic-key');
    vi.stubEnv('REDDIT_SUBREDDITS', 'selfhosted');
    vi.stubEnv('REDDIT_CLIENT_ID', 'id');
    vi.stubEnv('REDDIT_CLIENT_SECRET', 'secret');
    vi.stubEnv('REDDIT_USER_AGENT', 'ua');

    const capture = captureStdoutWrites();
    bootConfig();
    capture.restore();

    expect(capture.text()).toBe('');
    vi.unstubAllEnvs();
  });

  it('keeps loadConfig pure — no warning is written when it is called directly', () => {
    // The warning lives in `bootConfig`, not the validator: `loadConfig` is documented as
    // safe to call with a literal object in tests, and a validator that writes to stdout
    // would not be.
    const capture = captureStdoutWrites();
    loadConfig({ ...MINIMAL_VALID_ENV, REDDIT_SUBREDDITS: 'selfhosted' });
    capture.restore();
    expect(capture.text()).toBe('');
  });

  it('rejects a non-integer or negative REDDIT_MIN_COMMENTS_TO_EXPAND', () => {
    for (const value of ['not-a-number', '-1', '2.5']) {
      expect(() =>
        loadConfig({
          ...MINIMAL_VALID_ENV,
          ...REDDIT_CREDENTIALS,
          REDDIT_MIN_COMMENTS_TO_EXPAND: value,
        }),
      ).toThrow(/REDDIT_MIN_COMMENTS_TO_EXPAND must be a non-negative integer/);
    }
  });

  it('keeps the adapter settings enumerable — they are configuration, not credentials', () => {
    // The counterpart to the redaction tests below: `hackernews` and `appstore` hold no
    // secret, so a `{...config}` log line should still carry them.
    const spread = { ...loadConfig({ ...MINIMAL_VALID_ENV, HN_QUERIES: 'postgres' }) };
    expect(spread.hackernews.queries).toEqual(['postgres']);
    expect(Object.keys(spread)).toContain('appstore');
  });
});

describe('BUDGET_CEILING_USD, LOG_LEVEL, NODE_ENV', () => {
  it('defaults BUDGET_CEILING_USD to 70 (CLAUDE.md cost envelope)', () => {
    expect(loadConfig(MINIMAL_VALID_ENV).budgetCeilingUsd).toBe(70);
  });

  it('rejects a non-numeric BUDGET_CEILING_USD', () => {
    const env = { ...MINIMAL_VALID_ENV, BUDGET_CEILING_USD: 'not-a-number' };
    expect(() => loadConfig(env)).toThrow(/BUDGET_CEILING_USD/);
  });

  it('rejects a zero or negative BUDGET_CEILING_USD', () => {
    expect(() => loadConfig({ ...MINIMAL_VALID_ENV, BUDGET_CEILING_USD: '0' })).toThrow(
      /BUDGET_CEILING_USD/,
    );
    expect(() => loadConfig({ ...MINIMAL_VALID_ENV, BUDGET_CEILING_USD: '-5' })).toThrow(
      /BUDGET_CEILING_USD/,
    );
  });

  it('rejects an invalid LOG_LEVEL', () => {
    expect(() => loadConfig({ ...MINIMAL_VALID_ENV, LOG_LEVEL: 'verbose' })).toThrow(/LOG_LEVEL/);
  });

  it('rejects an invalid NODE_ENV', () => {
    expect(() => loadConfig({ ...MINIMAL_VALID_ENV, NODE_ENV: 'staging' })).toThrow(/NODE_ENV/);
  });
});

describe('loadConfig purity', () => {
  it('does not mutate the input record', () => {
    const env = Object.freeze({ ...MINIMAL_VALID_ENV });
    expect(() => loadConfig(env)).not.toThrow();
  });

  it('builds a usable Config from a literal object holding no real secrets', () => {
    const config = loadConfig({
      DATABASE_URL: 'postgresql://fixture:fixture@localhost:5432/fixture',
      ANTHROPIC_API_KEY: 'fixture-key',
    });
    expect(config).toBeInstanceOf(Object);
    expect(config.databaseUrl).toContain('fixture');
  });
});

describe('loadConfigFromEnv — the one process.env read in the repo', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('builds a Config from process.env via vitest env stubs, without this file writing process.env itself', () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://stub:stub@localhost:5432/stub_db');
    vi.stubEnv('ANTHROPIC_API_KEY', 'stub-anthropic-key');
    const config = loadConfigFromEnv();
    expect(config.databaseUrl).toBe('postgresql://stub:stub@localhost:5432/stub_db');
    expect(config.anthropicApiKey).toBe('stub-anthropic-key');
  });
});

describe('secret redaction (criterion 3) — every route the brief lists', () => {
  it('the sentinel really is present on the raw config fields (sanity check for the tests below)', () => {
    const config = configWithSentinel();
    expect(config.databaseUrl).toContain(SECRET_SENTINEL);
    expect(config.anthropicApiKey).toBe(SECRET_SENTINEL);
    expect(config.reddit?.clientId).toBe(SECRET_SENTINEL);
    expect(config.reddit?.clientSecret).toBe(SECRET_SENTINEL);
  });

  it('JSON.stringify(config) does not contain the sentinel', () => {
    const config = configWithSentinel();
    expect(JSON.stringify(config)).not.toContain(SECRET_SENTINEL);
  });

  it('util.inspect(config) does not contain the sentinel', () => {
    const config = configWithSentinel();
    expect(inspect(config)).not.toContain(SECRET_SENTINEL);
  });

  it('console.log(config) does not write the sentinel to stdout (it goes through util.inspect)', () => {
    const config = configWithSentinel();
    const capture = captureStdoutWrites();
    console.log(config);
    capture.restore();
    expect(capture.text()).not.toContain(SECRET_SENTINEL);
  });

  it('template-literal coercion of config does not contain the sentinel', () => {
    const config = configWithSentinel();
    const templated = `config is ${config}`;
    expect(templated).not.toContain(SECRET_SENTINEL);
  });

  it('String(config) does not contain the sentinel', () => {
    const config = configWithSentinel();
    expect(String(config)).not.toContain(SECRET_SENTINEL);
  });

  it('the non-secret REDDIT_USER_AGENT still appears in the redacted view (proves this is redaction, not blanket suppression)', () => {
    const config = configWithSentinel();
    expect(JSON.stringify(config)).toContain('fetch-app/0.1');
    expect(inspect(config)).toContain('fetch-app/0.1');
  });

  it('a validation failure on a secret variable does not echo the rejected value in the ConfigError message', () => {
    const badDatabaseUrl = `not-a-valid-url-${SECRET_SENTINEL}`;
    const thrown = catchError(() =>
      loadConfig({ DATABASE_URL: badDatabaseUrl, ANTHROPIC_API_KEY: SECRET_SENTINEL }),
    );
    expect(thrown).toBeInstanceOf(ConfigError);
    const configError = thrown as ConfigError;
    expect(configError.message).toContain('DATABASE_URL');
    expect(configError.message).not.toContain(SECRET_SENTINEL);
    expect(JSON.stringify(configError.context ?? {})).not.toContain(SECRET_SENTINEL);
    expect(configError.stack ?? '').not.toContain(SECRET_SENTINEL);
  });
});

// Fix round 1, Finding 1 (CRITICAL): the reviewer showed that redacting `JSON.stringify`,
// `util.inspect`, and `toString` is not enough — those three hooks only fire when *called
// directly* on a `Config` instance. Spreading, enumerating, or structured-cloning the
// instance instead bypasses all three, because those routes only ever look at own
// enumerable properties, never at the instance's methods. Each test below exercises one of
// those bypass routes directly against `configWithSentinel()`; the last one reproduces the
// concrete regression the reviewer found — `log.info('booted', { ...config })` — end to
// end through the real `lib/log.ts`, not just through a unit check of the spread result.
describe('secret redaction survives own-property enumeration, not just the serialization hooks (fix round 1, Finding 1)', () => {
  it('a shallow spread of config does not carry the sentinel', () => {
    const config = configWithSentinel();
    const spread = { ...config };
    expect(JSON.stringify(spread)).not.toContain(SECRET_SENTINEL);
  });

  it('a shallow spread of config.reddit on its own does not carry the sentinel', () => {
    const config = configWithSentinel();
    const spreadReddit = { ...config.reddit };
    expect(JSON.stringify(spreadReddit)).not.toContain(SECRET_SENTINEL);
  });

  it('Object.entries(config) does not carry the sentinel', () => {
    const config = configWithSentinel();
    expect(JSON.stringify(Object.entries(config))).not.toContain(SECRET_SENTINEL);
  });

  it('Object.keys(config) does not even name the secret fields as keys', () => {
    const config = configWithSentinel();
    const keys = Object.keys(config);
    expect(keys).not.toContain('databaseUrl');
    expect(keys).not.toContain('anthropicApiKey');
    expect(keys).not.toContain('reddit');
  });

  it('structuredClone(config) does not carry the sentinel', () => {
    const config = configWithSentinel();
    expect(JSON.stringify(structuredClone(config))).not.toContain(SECRET_SENTINEL);
  });

  it('spreading config still leaves non-secret fields (budgetCeilingUsd, logLevel, nodeEnv) intact', () => {
    // Proves the fields are genuinely absent from enumeration, not that the whole object
    // silently became empty — the non-secret plain fields are still own, enumerable
    // properties and a spread should still carry them.
    const config = configWithSentinel();
    const spread = { ...config };
    expect(spread.budgetCeilingUsd).toBe(config.budgetCeilingUsd);
    expect(spread.logLevel).toBe(config.logLevel);
    expect(spread.nodeEnv).toBe(config.nodeEnv);
  });

  it('the concrete regression: log.info("booted", { ...config }) emits no secret', () => {
    const config = configWithSentinel();
    const capture = captureStdoutWrites();
    log.info('booted', { ...config });
    capture.restore();
    expect(capture.text()).not.toContain(SECRET_SENTINEL);
  });
});
