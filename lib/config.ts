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
import { log } from './log.js';
import { SOURCES, type Source } from './types.js';

const REDACTED = '[REDACTED]';

const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
const NODE_ENVS = ['development', 'test', 'production'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];
export type NodeEnv = (typeof NODE_ENVS)[number];

export interface RedditConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly userAgent: string;
  /**
   * Which subreddits to sweep. `undefined` means "not configured" and leaves the adapter's
   * own default in force — this file never restates an adapter default, so the two can
   * never drift apart (I-05 composer resolution 2).
   */
  readonly subreddits: readonly string[] | undefined;
  /**
   * Product-visible ingest-volume knob: a post needs this many comments before expansion
   * spends a request on it. `undefined` leaves the adapter's own default (5) in force.
   */
  readonly minCommentsToExpand: number | undefined;
}

/**
 * Hacker News and App Store are free and unauthenticated, so unlike `reddit` these are never
 * `undefined` — the sources always run; only *what* they sweep is configurable. Every field
 * inside is optional in the same "undefined means the adapter's own default" sense.
 */
export interface HackerNewsConfig {
  readonly queries: readonly string[] | undefined;
}

export interface AppStoreConfig {
  readonly appIds: readonly string[] | undefined;
  readonly territories: readonly string[] | undefined;
}

/**
 * When ingestion runs, and what a failed run is allowed to do about it (SPEC I-06). Every
 * field here is settings rather than code specifically because the criterion is that an
 * operator can change *when* a source runs without editing a `.ts` file and without a
 * redeploy — a cron string living in a TypeScript module named "config" would not satisfy
 * that, so these route through the same env → `loadConfig` → `Config` path as everything
 * else in this file.
 */
export interface SchedulerConfig {
  /**
   * Per source, because the three do not warrant the same cadence: Hacker News is free and
   * unmetered, the App Store's RSS feeds are free but refresh slowly, and Reddit is capped
   * at 100 QPM. `undefined` means that source's schedule is switched off — distinct from
   * "not configured", which takes the default below. jobs/ *unschedules* an `undefined`
   * source rather than merely skipping it, since pg-boss persists schedules in the database
   * and a previously-registered cron keeps firing otherwise.
   */
  readonly cron: Readonly<Record<Source, string | undefined>>;
  /** IANA zone the cron expressions are interpreted in. UTC by default (CLAUDE.md: UTC, always). */
  readonly timezone: string;
  /** How many times a failed run is retried before it is given up on and dead-lettered. */
  readonly retryLimit: number;
  /** Delay before the first retry; doubles (with jitter) per attempt up to `retryDelayMaxSeconds`. */
  readonly retryDelaySeconds: number;
  readonly retryDelayMaxSeconds: number;
  /**
   * How long one run may hold its queue's slot before pg-boss reclaims the job. This is the
   * one setting that can defeat the per-source lock: a run still executing past its expiry
   * has already lost its `active` claim, so a retry may start alongside it. Generous by
   * default and configurable for exactly that reason.
   */
  readonly jobExpirySeconds: number;
}

interface ConfigFields {
  readonly databaseUrl: string;
  readonly anthropicApiKey: string;
  readonly reddit: RedditConfig | undefined;
  readonly hackernews: HackerNewsConfig;
  readonly appstore: AppStoreConfig;
  readonly scheduler: SchedulerConfig;
  readonly budgetCeilingUsd: number;
  readonly logLevel: LogLevel;
  readonly nodeEnv: NodeEnv;
}

// Default derived from CLAUDE.md's cost envelope ("under $70/month") — F-05 reads this
// value as the budget guard's ceiling.
const DEFAULT_BUDGET_CEILING_USD = 70;
const DEFAULT_LOG_LEVEL: LogLevel = 'info';
const DEFAULT_NODE_ENV: NodeEnv = 'development';

/** The literal that switches a source's schedule off, as opposed to leaving it defaulted. */
const SCHEDULE_DISABLED = 'off';

const SCHEDULE_ENV_VARS = {
  hackernews: 'INGEST_SCHEDULE_HACKERNEWS',
  appstore: 'INGEST_SCHEDULE_APPSTORE',
  reddit: 'INGEST_SCHEDULE_REDDIT',
} as const satisfies Readonly<Record<Source, string>>;

/**
 * Cadence defaults, one per source, chosen from what each platform actually gives back
 * rather than from one interval imposed on all three:
 *
 * - Hacker News (Algolia + Firebase, free and unmetered) turns over continuously, so a short
 *   interval keeps each run small; the persisted cursor means frequency changes how the same
 *   volume is *divided*, not how much is fetched.
 * - The App Store's RSS review feeds are CDN-cached and refresh far more slowly than hourly,
 *   so polling harder returns the same page twice for nothing.
 * - Reddit is capped at 100 QPM and, per CLAUDE.md global rule 4, is designed for
 *   personal-use limits until a license exists — restraint is the point, not throughput.
 *
 * The three minute offsets are deliberate. Identical minutes would put all three sources on
 * the same tick, contending on one connection pool for no benefit, and would make an
 * overlapping-run bug hardest to see precisely when it is most likely to happen.
 */
const DEFAULT_SCHEDULE_CRON = {
  hackernews: '*/15 * * * *',
  appstore: '17 * * * *',
  reddit: '37 * * * *',
} as const satisfies Readonly<Record<Source, string>>;

const DEFAULT_SCHEDULE_TIMEZONE = 'UTC';
/** Three retries after the first attempt. */
const DEFAULT_RETRY_LIMIT = 3;
const DEFAULT_RETRY_DELAY_SECONDS = 60;
/**
 * Caps the backoff below the shortest default cadence, so a retry chain for one source
 * cannot still be waiting when that source's next scheduled tick arrives.
 */
const DEFAULT_RETRY_DELAY_MAX_SECONDS = 900;
const DEFAULT_JOB_EXPIRY_SECONDS = 3600;

/**
 * Deliberately shallow: it checks the field *count* and rejects characters no cron field can
 * contain, and leaves the rest to the cron parser pg-boss registers the schedule with.
 *
 * The split is not arbitrary. pg-boss rejects a garbage field ("Invalid characters, got
 * value: a") but was verified to accept a four-field expression silently, which is the
 * realistic typo: a four-field expression is not rejected anywhere downstream, it simply
 * means something other than what whoever typed it intended, forever. Counting fields catches
 * that. Going further — validating ranges, or rejecting `L`/`#`/`W` — would risk rejecting
 * expressions the parser accepts, trading a silent misfire for a boot that refuses a valid
 * schedule.
 */
const CRON_FIELD_PATTERN = /^[0-9A-Za-z*,\-/?#LW]+$/;
const CRON_FIELD_COUNT = 5;

function isCronExpression(value: string): boolean {
  const fields = value.trim().split(/\s+/);
  return fields.length === CRON_FIELD_COUNT && fields.every((f) => CRON_FIELD_PATTERN.test(f));
}

/**
 * `Intl` is the check rather than a list of zone names because it is the same database the
 * runtime resolves the zone against. pg-boss was verified to accept an unknown zone without
 * complaint, so nothing downstream catches this.
 */
function isTimeZone(value: string): boolean {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone !== '';
  } catch {
    // An unknown zone is a RangeError out of the constructor — the answer to "is this a
    // zone?" is no, which is a result, not a swallowed failure.
    return false;
  }
}

// Fix round 1, Finding 1 (CRITICAL): the previous version assigned the secret fields via
// `this.foo = fields.foo`, which makes them ordinary own enumerable data properties —
// `toJSON`/`[inspect.custom]`/`toString` redact `JSON.stringify(config)`,
// `util.inspect(config)`, and `String(config)` directly, but a caller who instead writes
// `{...config}`, `Object.entries(config)`, or `structuredClone(config)` bypasses all three
// hooks and gets the raw secret back, because none of those routes call the instance's own
// methods — they only ever enumerate own enumerable properties. The concrete regression the
// reviewer reproduced was `log.info('booted', { ...config })` printing DATABASE_URL and
// ANTHROPIC_API_KEY straight to stdout.
//
// The first fix attempted here used real private fields (`#databaseUrl`) exposed through
// `get databaseUrl()` accessors. That closes the enumeration hole (private fields are
// invisible to spread/Object.keys/structuredClone) but turned out to have its own crash:
// Vitest's `toEqual` compares a class instance by cloning it via `Object.create(prototype)`
// plus copying property descriptors — a clone that was never run through the real
// constructor, so the class's private-field slot was never initialized for it. Calling the
// inherited getter on that clone throws `TypeError: Cannot read private member ... from an
// object whose class did not declare it` — reproduced directly against Vitest 4.1.10 before
// settling on the approach below, so any later module (including its own tests) that calls
// `toEqual`/`toMatchObject` against a `Config` or `RedditConfig` would have hit this.
//
// The fix that avoids both problems: `Object.defineProperty` with `enumerable: false` on
// the instance. This is a genuine, ordinary own data property — reading `config.databaseUrl`
// is a normal property access, and Vitest's clone-and-compare machinery copies and reads it
// with no special slot to fail to initialize — but with `enumerable: false` it is invisible
// to `{...config}`, `Object.keys`/`values`/`entries`, `for...in`, `JSON.stringify` without a
// `toJSON` override, and `structuredClone`, all of which only ever touch *enumerable* own
// properties. `writable: false, configurable: false` make it immutable the same way
// `readonly` does for an ordinary field.
function defineHiddenValue(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: false,
    writable: false,
    configurable: false,
  });
}

class RedditConfigValue implements RedditConfig {
  // `declare` tells TypeScript these properties exist on every instance without emitting a
  // field initializer that would otherwise stomp on (or conflict with) the
  // `defineHiddenValue` calls in the constructor, which are the actual runtime source of
  // truth for these two — see the comment above `defineHiddenValue`.
  declare readonly clientId: string;
  declare readonly clientSecret: string;
  readonly userAgent: string;
  readonly subreddits: readonly string[] | undefined;
  readonly minCommentsToExpand: number | undefined;

  constructor(fields: RedditConfig) {
    defineHiddenValue(this, 'clientId', fields.clientId);
    defineHiddenValue(this, 'clientSecret', fields.clientSecret);
    // Not a secret (SPEC F-03 resolution 3 table) — a UA string identifying the app to
    // Reddit's API, not a credential — so it stays a plain, own, enumerable field. The two
    // below are ordinary ingest settings (which subreddits, how many comments before a
    // thread is worth a request), not credentials, so they get the same treatment.
    this.userAgent = fields.userAgent;
    this.subreddits = fields.subreddits;
    this.minCommentsToExpand = fields.minCommentsToExpand;
  }
}

/**
 * The validated, typed settings surface. `databaseUrl`, `anthropicApiKey`, and `reddit` are
 * non-enumerable own properties (see the comment above `defineHiddenValue`), so the four
 * secret values are absent from *any* own-property enumeration of a `Config` — not just
 * from `toJSON`/`inspect`/`toString`, which exist on top of that to give
 * `JSON.stringify(config)`, `util.inspect(config)`, `console.log(config)`, and
 * `String(config)`/template coercion an explicit, readable redacted view rather than
 * silently omitting the keys. Reading `config.databaseUrl` etc. directly still returns the
 * real value — legitimate consumers (lib/net.ts, lib/llm.ts, the Reddit adapter) need it.
 */
export class Config implements ConfigFields {
  declare readonly databaseUrl: string;
  declare readonly anthropicApiKey: string;
  declare readonly reddit: RedditConfig | undefined;
  readonly hackernews: HackerNewsConfig;
  readonly appstore: AppStoreConfig;
  readonly scheduler: SchedulerConfig;
  readonly budgetCeilingUsd: number;
  readonly logLevel: LogLevel;
  readonly nodeEnv: NodeEnv;

  constructor(fields: ConfigFields) {
    defineHiddenValue(this, 'databaseUrl', fields.databaseUrl);
    defineHiddenValue(this, 'anthropicApiKey', fields.anthropicApiKey);
    // `reddit` stays hidden as a whole because two of its five fields are credentials;
    // `hackernews` and `appstore` hold no secret at all, so they are ordinary enumerable
    // fields that a `{...config}` log line may legitimately print.
    defineHiddenValue(
      this,
      'reddit',
      fields.reddit === undefined ? undefined : new RedditConfigValue(fields.reddit),
    );
    this.hackernews = fields.hackernews;
    this.appstore = fields.appstore;
    this.scheduler = fields.scheduler;
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
            subreddits: config.reddit.subreddits,
            minCommentsToExpand: config.reddit.minCommentsToExpand,
          },
    hackernews: config.hackernews,
    appstore: config.appstore,
    scheduler: config.scheduler,
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

/**
 * Structural rather than zod's own context type so these two helpers stay independent of
 * which zod version's issue API is in play — they only ever add a hand-written message,
 * which is the same secret-free discipline every other issue in this file follows.
 */
interface IssueCollector {
  addIssue(message: string): void;
}

/** `undefined`/empty means "not configured" everywhere in this file, so it defers to `fallback`. */
function optionalInteger(raw: string | undefined, fallback: number): number {
  return raw === undefined || raw === '' ? fallback : Number(raw);
}

function checkInteger(
  ctx: IssueCollector,
  name: string,
  raw: string | undefined,
  minimum: number,
): void {
  if (raw === undefined || raw === '') {
    return;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < minimum) {
    ctx.addIssue(`${name} must be an integer of at least ${String(minimum)}`);
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
    REDDIT_SUBREDDITS: z.string().optional(),
    REDDIT_MIN_COMMENTS_TO_EXPAND: z.string().optional(),
    HN_QUERIES: z.string().optional(),
    APPSTORE_APP_IDS: z.string().optional(),
    APPSTORE_TERRITORIES: z.string().optional(),
    INGEST_SCHEDULE_HACKERNEWS: z.string().optional(),
    INGEST_SCHEDULE_APPSTORE: z.string().optional(),
    INGEST_SCHEDULE_REDDIT: z.string().optional(),
    INGEST_SCHEDULE_TIMEZONE: z.string().optional(),
    INGEST_RETRY_LIMIT: z.string().optional(),
    INGEST_RETRY_DELAY_SECONDS: z.string().optional(),
    INGEST_RETRY_DELAY_MAX_SECONDS: z.string().optional(),
    INGEST_JOB_EXPIRY_SECONDS: z.string().optional(),
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

    if (
      data.REDDIT_MIN_COMMENTS_TO_EXPAND !== undefined &&
      data.REDDIT_MIN_COMMENTS_TO_EXPAND !== ''
    ) {
      const parsed = Number(data.REDDIT_MIN_COMMENTS_TO_EXPAND);
      if (!Number.isInteger(parsed) || parsed < 0) {
        ctx.addIssue('REDDIT_MIN_COMMENTS_TO_EXPAND must be a non-negative integer');
      }
    }

    for (const source of SOURCES) {
      const name = SCHEDULE_ENV_VARS[source];
      const raw = data[name];
      if (raw === undefined || raw === '' || raw.trim().toLowerCase() === SCHEDULE_DISABLED) {
        continue;
      }
      if (!isCronExpression(raw)) {
        ctx.addIssue(
          `${name} must be a five-field cron expression (minute hour day-of-month month day-of-week) or "${SCHEDULE_DISABLED}"`,
        );
      }
    }

    if (
      data.INGEST_SCHEDULE_TIMEZONE !== undefined &&
      data.INGEST_SCHEDULE_TIMEZONE !== '' &&
      !isTimeZone(data.INGEST_SCHEDULE_TIMEZONE)
    ) {
      ctx.addIssue(
        'INGEST_SCHEDULE_TIMEZONE must be an IANA time zone name (e.g. UTC, Europe/London)',
      );
    }

    // `retryLimit` is the only one that may be 0 — that is "attempt once, never retry",
    // a legitimate choice. A zero anywhere else would mean an interval that is not one.
    checkInteger(ctx, 'INGEST_RETRY_LIMIT', data.INGEST_RETRY_LIMIT, 0);
    checkInteger(ctx, 'INGEST_RETRY_DELAY_SECONDS', data.INGEST_RETRY_DELAY_SECONDS, 1);
    checkInteger(ctx, 'INGEST_RETRY_DELAY_MAX_SECONDS', data.INGEST_RETRY_DELAY_MAX_SECONDS, 1);
    checkInteger(ctx, 'INGEST_JOB_EXPIRY_SECONDS', data.INGEST_JOB_EXPIRY_SECONDS, 1);

    // Caught here rather than left to pg-boss, which clamps each delay to the maximum and so
    // turns an inverted pair into a fixed-delay retry policy that silently is not backoff.
    const delay = optionalInteger(data.INGEST_RETRY_DELAY_SECONDS, DEFAULT_RETRY_DELAY_SECONDS);
    const maxDelay = optionalInteger(
      data.INGEST_RETRY_DELAY_MAX_SECONDS,
      DEFAULT_RETRY_DELAY_MAX_SECONDS,
    );
    if (Number.isInteger(delay) && Number.isInteger(maxDelay) && maxDelay < delay) {
      ctx.addIssue(
        'INGEST_RETRY_DELAY_MAX_SECONDS must be greater than or equal to INGEST_RETRY_DELAY_SECONDS — a smaller maximum clamps every retry to one fixed delay, which is not backoff',
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

/**
 * Comma-separated list -> array, or `undefined` for "not configured" so the consuming
 * adapter's own default stays in force. Empty entries are dropped (a trailing comma is a
 * typo, not a request to sweep the empty string); a value that is entirely empty or only
 * separators is therefore indistinguishable from the variable being unset, which is the
 * same "undefined or empty means absent" rule every other field in this file already uses.
 */
function parseList(value: string | undefined): readonly string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  const items = value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
  return items.length === 0 ? undefined : items;
}

type ValidatedEnv = z.infer<typeof EnvSchema>;

function toSchedulerConfig(env: ValidatedEnv): SchedulerConfig {
  const cron: Record<Source, string | undefined> = {
    hackernews: undefined,
    appstore: undefined,
    reddit: undefined,
  };
  for (const source of SOURCES) {
    const raw = env[SCHEDULE_ENV_VARS[source]];
    if (raw === undefined || raw === '') {
      cron[source] = DEFAULT_SCHEDULE_CRON[source];
    } else if (raw.trim().toLowerCase() === SCHEDULE_DISABLED) {
      cron[source] = undefined;
    } else {
      cron[source] = raw.trim();
    }
  }
  return {
    cron,
    timezone:
      env.INGEST_SCHEDULE_TIMEZONE === undefined || env.INGEST_SCHEDULE_TIMEZONE === ''
        ? DEFAULT_SCHEDULE_TIMEZONE
        : env.INGEST_SCHEDULE_TIMEZONE,
    retryLimit: optionalInteger(env.INGEST_RETRY_LIMIT, DEFAULT_RETRY_LIMIT),
    retryDelaySeconds: optionalInteger(env.INGEST_RETRY_DELAY_SECONDS, DEFAULT_RETRY_DELAY_SECONDS),
    retryDelayMaxSeconds: optionalInteger(
      env.INGEST_RETRY_DELAY_MAX_SECONDS,
      DEFAULT_RETRY_DELAY_MAX_SECONDS,
    ),
    jobExpirySeconds: optionalInteger(env.INGEST_JOB_EXPIRY_SECONDS, DEFAULT_JOB_EXPIRY_SECONDS),
  };
}

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
          subreddits: parseList(env.REDDIT_SUBREDDITS),
          minCommentsToExpand:
            env.REDDIT_MIN_COMMENTS_TO_EXPAND === undefined ||
            env.REDDIT_MIN_COMMENTS_TO_EXPAND === ''
              ? undefined
              : Number(env.REDDIT_MIN_COMMENTS_TO_EXPAND),
        }
      : undefined;

  return new Config({
    // `?? ''` is a defensive fallback that can never actually run — EnvSchema's
    // superRefine already rejected undefined/empty here — kept instead of a `!` assertion
    // so this function stays type-safe on its own without re-deriving that guarantee.
    databaseUrl: env.DATABASE_URL ?? '',
    anthropicApiKey: env.ANTHROPIC_API_KEY ?? '',
    reddit,
    hackernews: { queries: parseList(env.HN_QUERIES) },
    appstore: {
      appIds: parseList(env.APPSTORE_APP_IDS),
      territories: parseList(env.APPSTORE_TERRITORIES),
    },
    scheduler: toSchedulerConfig(env),
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
 * Settings that only mean something once Reddit has credentials. Without them I-05 leaves
 * the Reddit adapter out of the registry entirely (blocker B-09 — Reddit blocks
 * unauthenticated API access), so these are read by nothing.
 *
 * Fix round 1, Finding 5: this used to be a hard `ConfigError`, which meant deleting Reddit
 * credentials from a `.env` that still named subreddits stopped Hacker News and App Store
 * ingestion too — a whole-pipeline outage over a setting for one source. The silence it was
 * guarding against no longer exists either: the registry records the skip with its reason
 * and the orchestrator writes that onto every run row. A warning is the proportionate
 * response, so the two sources that *can* run keep running.
 *
 * It lives here rather than in `loadConfig` deliberately: `loadConfig` is pure by contract
 * ("no global state, no I/O, safe to call with a literal object in tests") and a validator
 * that writes to stdout would not be. `bootConfig` is already the impure boot-time entry
 * point — it writes to stderr and calls `process.exit` — so the warning belongs with it.
 */
const REDDIT_SETTINGS_NEEDING_CREDENTIALS = [
  'REDDIT_SUBREDDITS',
  'REDDIT_MIN_COMMENTS_TO_EXPAND',
] as const;

function warnAboutUnusableRedditSettings(config: Config, env: NodeJS.ProcessEnv): void {
  if (config.reddit !== undefined) {
    return;
  }
  const configured = REDDIT_SETTINGS_NEEDING_CREDENTIALS.filter((name) => {
    const value = env[name];
    return value !== undefined && value !== '';
  });
  if (configured.length === 0) {
    return;
  }
  log.warn(
    'Reddit settings are configured but Reddit has no credentials, so they will be ignored',
    {
      // Names only, never values — the same rule the ConfigError messages follow, and
      // REDDIT_SUBREDDITS is not a secret but neighbours two that are.
      ignored: configured,
      required: ['REDDIT_CLIENT_ID', 'REDDIT_CLIENT_SECRET', 'REDDIT_USER_AGENT'],
      effect: 'Reddit ingestion is skipped; every other source runs normally',
    },
  );
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
    const config = loadConfigFromEnv();
    warnAboutUnusableRedditSettings(config, process.env);
    return config;
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }
}
