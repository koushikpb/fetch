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
    expect(config.reddit).toEqual({
      clientId: 'reddit-client-id',
      clientSecret: 'reddit-client-secret',
      userAgent: 'fetch-app/0.1 (by /u/example)',
    });
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
    expect(loadConfig(env).reddit).toEqual({
      clientId: 'id',
      clientSecret: 'secret',
      userAgent: 'ua',
    });
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
  function configWithSentinel(): ReturnType<typeof loadConfig> {
    return loadConfig({
      DATABASE_URL: `postgresql://user:${SECRET_SENTINEL}@localhost:5432/db`,
      ANTHROPIC_API_KEY: SECRET_SENTINEL,
      REDDIT_CLIENT_ID: SECRET_SENTINEL,
      REDDIT_CLIENT_SECRET: SECRET_SENTINEL,
      REDDIT_USER_AGENT: 'fetch-app/0.1 (by /u/example)',
    });
  }

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
