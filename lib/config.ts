// Typed config loader: the single seam every later module reads settings and secrets
// through (SPEC F-03). `process.env` is read in exactly one place in this file
// (`loadConfigFromEnv`) and nowhere else in the repo — eslint.config.js's PROCESS_ENV_BAN
// enforces that mechanically (criterion 2), the same way lib/net.ts is the sole route to
// bare `fetch`.
//
// `loadConfig` is a pure function over an injected env record (composer resolution 2) so
// tests can build a `Config` from a literal object with no global mutation and no real
// secrets, and so the boot-time exit behaviour (criterion 1) lives in exactly one place —
// `bootConfig` — rather than being baked into the validator itself, which would make the
// validator untestable without killing the test process.
import { inspect } from 'node:util';
import { z } from 'zod';
import { ConfigError } from './errors.js';

const REDACTED = '[REDACTED]';

const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
const NODE_ENVS = ['development', 'test', 'production'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];
export type NodeEnv = (typeof NODE_ENVS)[number];

export interface RedditConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly userAgent: string;
}

interface ConfigFields {
  readonly databaseUrl: string;
  readonly anthropicApiKey: string;
  readonly reddit: RedditConfig | undefined;
  readonly budgetCeilingUsd: number;
  readonly logLevel: LogLevel;
  readonly nodeEnv: NodeEnv;
}

// Default derived from CLAUDE.md's cost envelope ("under $70/month") — F-05 reads this
// value as the budget guard's ceiling.
const DEFAULT_BUDGET_CEILING_USD = 70;
const DEFAULT_LOG_LEVEL: LogLevel = 'info';
const DEFAULT_NODE_ENV: NodeEnv = 'development';

/**
 * The validated, typed settings surface. Deliberately a class rather than a plain object:
 * `toJSON`, `[inspect.custom]`, and `toString` below are what make secret redaction a
 * property of the object itself (composer resolution 5) instead of something every call
 * site has to remember to do. Reading `config.databaseUrl` etc. directly still returns the
 * real value — redaction only guards the serialization routes a careless `console.log`,
 * template literal, or `JSON.stringify` would go through.
 */
export class Config implements ConfigFields {
  readonly databaseUrl: string;
  readonly anthropicApiKey: string;
  readonly reddit: RedditConfig | undefined;
  readonly budgetCeilingUsd: number;
  readonly logLevel: LogLevel;
  readonly nodeEnv: NodeEnv;

  constructor(fields: ConfigFields) {
    this.databaseUrl = fields.databaseUrl;
    this.anthropicApiKey = fields.anthropicApiKey;
    this.reddit = fields.reddit;
    this.budgetCeilingUsd = fields.budgetCeilingUsd;
    this.logLevel = fields.logLevel;
    this.nodeEnv = fields.nodeEnv;
  }

  // `JSON.stringify` looks for `toJSON` before falling back to enumerable-own-property
  // serialization — this is the route `console.log` does NOT take (that goes through
  // util.inspect instead, below), so both are required; neither alone covers criterion 3.
  toJSON(): Record<string, unknown> {
    return redactedView(this);
  }

  // Node's `util.inspect` — and therefore `console.log`, which calls it internally on
  // non-string arguments — checks for a method at this well-known symbol before falling
  // back to default object formatting. `JSON.stringify` does not honour it, which is why
  // `toJSON` above still has to exist independently.
  [inspect.custom](): string {
    return `Config ${inspect(redactedView(this), { colors: false })}`;
  }

  // Covers `String(config)` and template-literal coercion (`` `${config}` ``) — both call
  // `ToString`, which uses `toString` here rather than `util.inspect` or `JSON.stringify`.
  toString(): string {
    return `Config ${JSON.stringify(redactedView(this))}`;
  }
}

function redactedView(config: ConfigFields): Record<string, unknown> {
  return {
    databaseUrl: REDACTED,
    anthropicApiKey: REDACTED,
    reddit:
      config.reddit === undefined
        ? undefined
        : {
            clientId: REDACTED,
            clientSecret: REDACTED,
            // Not a secret (SPEC F-03 resolution 3 table) — a UA string identifying the
            // app to Reddit's API, not a credential.
            userAgent: config.reddit.userAgent,
          },
    budgetCeilingUsd: config.budgetCeilingUsd,
    logLevel: config.logLevel,
    nodeEnv: config.nodeEnv,
  };
}

function isPostgresUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === 'postgres:' || protocol === 'postgresql:';
  } catch {
    // Malformed input (no scheme, empty string, etc.) — not a postgres URL either way.
    return false;
  }
}

// Every field is an untyped optional string at the schema level; all real validation
// (required-ness, format, cross-field Reddit relationship) happens in `superRefine` below
// with hand-written, secret-free messages. This sidesteps zod's built-in per-field error
// templates entirely — safer than trusting that no future zod default ever interpolates a
// rejected value into a message, which criterion 3 cannot tolerate for the secret fields.
const EnvSchema = z
  .object({
    DATABASE_URL: z.string().optional(),
    ANTHROPIC_API_KEY: z.string().optional(),
    REDDIT_CLIENT_ID: z.string().optional(),
    REDDIT_CLIENT_SECRET: z.string().optional(),
    REDDIT_USER_AGENT: z.string().optional(),
    BUDGET_CEILING_USD: z.string().optional(),
    LOG_LEVEL: z.string().optional(),
    NODE_ENV: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.DATABASE_URL === undefined || data.DATABASE_URL === '') {
      ctx.addIssue('DATABASE_URL is required');
    } else if (!isPostgresUrl(data.DATABASE_URL)) {
      ctx.addIssue('DATABASE_URL must be a valid postgres:// or postgresql:// URL');
    }

    if (data.ANTHROPIC_API_KEY === undefined || data.ANTHROPIC_API_KEY === '') {
      ctx.addIssue('ANTHROPIC_API_KEY is required');
    }

    // The three Reddit variables are optional individually but must be all-present or
    // all-absent (composer resolution 3) — a half-configured adapter would otherwise fail
    // at runtime in a much more confusing way than at boot.
    const redditPresence = {
      REDDIT_CLIENT_ID: data.REDDIT_CLIENT_ID !== undefined && data.REDDIT_CLIENT_ID !== '',
      REDDIT_CLIENT_SECRET:
        data.REDDIT_CLIENT_SECRET !== undefined && data.REDDIT_CLIENT_SECRET !== '',
      REDDIT_USER_AGENT: data.REDDIT_USER_AGENT !== undefined && data.REDDIT_USER_AGENT !== '',
    };
    const redditPresentCount = Object.values(redditPresence).filter(Boolean).length;
    if (redditPresentCount !== 0 && redditPresentCount !== 3) {
      const missing = Object.entries(redditPresence)
        .filter(([, present]) => !present)
        .map(([name]) => name);
      ctx.addIssue(
        `REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET, and REDDIT_USER_AGENT must all be set together or all omitted (missing: ${missing.join(', ')})`,
      );
    }

    if (data.BUDGET_CEILING_USD !== undefined) {
      const parsed = Number(data.BUDGET_CEILING_USD);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        ctx.addIssue('BUDGET_CEILING_USD must be a positive number');
      }
    }

    if (data.LOG_LEVEL !== undefined && !isOneOf(data.LOG_LEVEL, LOG_LEVELS)) {
      ctx.addIssue(`LOG_LEVEL must be one of: ${LOG_LEVELS.join(', ')}`);
    }

    if (data.NODE_ENV !== undefined && !isOneOf(data.NODE_ENV, NODE_ENVS)) {
      ctx.addIssue(`NODE_ENV must be one of: ${NODE_ENVS.join(', ')}`);
    }
  });

function isOneOf<T extends string>(value: string, options: readonly T[]): value is T {
  return (options as readonly string[]).includes(value);
}

type ValidatedEnv = z.infer<typeof EnvSchema>;

// Only reachable once `EnvSchema`'s superRefine above has already confirmed every field is
// well-formed, so the coercions here (Number(...), the literal casts) cannot fail — this
// function's job is exclusively to apply defaults and build the typed `Config`, not to
// re-validate.
function toConfig(env: ValidatedEnv): Config {
  const reddit: RedditConfig | undefined =
    env.REDDIT_CLIENT_ID !== undefined &&
    env.REDDIT_CLIENT_ID !== '' &&
    env.REDDIT_CLIENT_SECRET !== undefined &&
    env.REDDIT_USER_AGENT !== undefined
      ? {
          clientId: env.REDDIT_CLIENT_ID,
          clientSecret: env.REDDIT_CLIENT_SECRET,
          userAgent: env.REDDIT_USER_AGENT,
        }
      : undefined;

  return new Config({
    // `?? ''` is a defensive fallback that can never actually run — EnvSchema's
    // superRefine already rejected undefined/empty here — kept instead of a `!` assertion
    // so this function stays type-safe on its own without re-deriving that guarantee.
    databaseUrl: env.DATABASE_URL ?? '',
    anthropicApiKey: env.ANTHROPIC_API_KEY ?? '',
    reddit,
    budgetCeilingUsd:
      env.BUDGET_CEILING_USD === undefined
        ? DEFAULT_BUDGET_CEILING_USD
        : Number(env.BUDGET_CEILING_USD),
    // `isOneOf` re-narrows rather than casting with `as` — cheap, and keeps this function
    // from having to trust that superRefine validated the same way it reads here.
    logLevel:
      env.LOG_LEVEL !== undefined && isOneOf(env.LOG_LEVEL, LOG_LEVELS)
        ? env.LOG_LEVEL
        : DEFAULT_LOG_LEVEL,
    nodeEnv:
      env.NODE_ENV !== undefined && isOneOf(env.NODE_ENV, NODE_ENVS)
        ? env.NODE_ENV
        : DEFAULT_NODE_ENV,
  });
}

/**
 * Validates and builds a `Config` from an injected env record. Pure — no global state, no
 * I/O, safe to call with a literal object in tests. Throws `ConfigError` listing every
 * validation failure at once (composer resolution 4: "a boot loop that reveals one missing
 * variable per run is exactly the 'loudly' this criterion is guarding against"), naming
 * only variable names, never their values.
 */
export function loadConfig(env: Record<string, string | undefined>): Config {
  const result = EnvSchema.safeParse(env);
  if (!result.success) {
    const messages = result.error.issues.map((issue) => issue.message);
    throw new ConfigError(`Invalid configuration:\n- ${messages.join('\n- ')}`, {
      context: { issueCount: messages.length },
    });
  }
  return toConfig(result.data);
}

/**
 * The thin accessor that supplies `process.env` — the one read of it in the entire repo
 * (composer resolution 2; enforced by eslint.config.js's PROCESS_ENV_BAN elsewhere).
 */
export function loadConfigFromEnv(): Config {
  return loadConfig(process.env);
}

/**
 * Boot-time entry point (SPEC F-03 criterion 1). `loadConfig`/`loadConfigFromEnv` never
 * call `process.exit` themselves — a library that can kill the process is untestable —
 * so this is the one place that catches `ConfigError`, writes its message to stderr, and
 * exits non-zero. Any other thrown value is a bug elsewhere, not a config problem, and is
 * rethrown rather than swallowed.
 */
export function bootConfig(): Config {
  try {
    return loadConfigFromEnv();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }
}
