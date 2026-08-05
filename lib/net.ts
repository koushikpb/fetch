// The single outbound HTTP path (CLAUDE.md: "All outbound network calls go through
// lib/net.ts"). Every source adapter in Phase 1 calls `netClient.request(...)` (or builds
// its own isolated `createNetClient(...)` for tests) instead of calling the global `fetch`
// directly — eslint.config.js's FETCH_BAN makes this file the sole exception mechanically.
//
// Time, sleep, and randomness are constructor-injected with real defaults (`Date.now`,
// a real `setTimeout`-based sleep, `Math.random`) rather than relying on
// `vi.useFakeTimers()` in tests. That keeps the seam a property of this module — any
// caller, not just a test runner, can supply a deterministic clock — and lets the test
// suite assert an exact computed delay sequence without waiting on the real clock for
// exponential backoff, which would otherwise make the suite slow and occasionally flaky
// under load.
import { NetworkError, RateLimitError, TimeoutError, UpstreamError } from './errors.js';
import { log } from './log.js';

export interface RateLimitConfig {
  /** Requests allowed per `intervalMs`. */
  readonly limit: number;
  readonly intervalMs: number;
}

// Reddit's free API tier caps clients at 100 requests per minute; CLAUDE.md global rule 4
// requires respecting platform rate limits, and the architecture table pins this exact
// number for the Reddit adapter (I-04). `oauth.reddit.com` is the host every authenticated
// call in that adapter hits (the OAuth token endpoint itself, `www.reddit.com/api/v1/access_token`,
// is a different host and isn't covered by this default — I-04 can add it explicitly if its
// token-refresh traffic needs its own limit). Callers extend or override this map at
// `createNetClient({ rateLimits })`; unlisted hosts are not rate-limited at all.
export const DEFAULT_RATE_LIMITS: Readonly<Record<string, RateLimitConfig>> = Object.freeze({
  'oauth.reddit.com': Object.freeze({ limit: 100, intervalMs: 60_000 }),
});

export interface RetryConfig {
  /** Total attempts including the first, not the retry count. */
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

export const DEFAULT_RETRY: RetryConfig = Object.freeze({
  maxAttempts: 5,
  baseDelayMs: 250,
  maxDelayMs: 30_000,
});

export const DEFAULT_TIMEOUT_MS = 10_000;

/** The shape a fake transport must satisfy in tests; the real default wraps global `fetch`. */
export type Transport = (url: string, init: RequestInit) => Promise<Response>;

export interface NetRequestOptions {
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  // Indexed off the global `RequestInit` rather than naming `BodyInit` directly — `@types/node`
  // declares `Response`/`Request`/`Headers`/`fetch`/`RequestInit` as globals (see
  // @types/node/web-globals/fetch.d.ts) but never re-exports the `BodyInit` name itself, so
  // referencing it bare would mean importing an undeclared transitive dependency
  // (`undici-types`) instead of relying on what's actually public.
  readonly body?: RequestInit['body'];
  readonly timeoutMs?: number;
}

export interface NetClientOptions {
  /** Merged over `DEFAULT_RATE_LIMITS`; an entry here for an existing host replaces it. */
  readonly rateLimits?: Readonly<Record<string, RateLimitConfig>>;
  readonly retry?: Partial<RetryConfig>;
  readonly defaultTimeoutMs?: number;
  readonly transport?: Transport;
  /** Injectable clock, in epoch milliseconds. Defaults to `Date.now`. */
  readonly now?: () => number;
  /** Injectable delay. Defaults to a real `setTimeout`-backed sleep. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Injectable source of a float in `[0, 1)`. Defaults to `Math.random`. */
  readonly jitter?: () => number;
}

export interface NetClient {
  request(url: string, options?: NetRequestOptions): Promise<Response>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A continuous-refill token bucket, not a fixed window counter: a fixed window lets a
// caller spend a full interval's budget in the last millisecond of one window and again in
// the first millisecond of the next, briefly running at ~2x the configured rate. Refilling
// continuously as a function of elapsed time avoids that.
//
// `acquireDelayMs` reserves the token immediately (by decrementing, possibly below zero)
// rather than only computing a delay, so that concurrent callers queue correctly: a second
// caller arriving before the first one's returned delay has elapsed still sees the debited
// count and gets a proportionally longer wait, instead of every concurrent caller computing
// the same "0ms available" answer off the same stale token count.
class TokenBucket {
  #tokens: number;
  #lastRefillMs: number;
  readonly #capacity: number;
  readonly #intervalMs: number;
  readonly #now: () => number;

  constructor(config: RateLimitConfig, now: () => number) {
    this.#capacity = config.limit;
    this.#intervalMs = config.intervalMs;
    this.#now = now;
    this.#tokens = config.limit;
    this.#lastRefillMs = now();
  }

  acquireDelayMs(): number {
    const now = this.#now();
    const elapsedMs = now - this.#lastRefillMs;
    if (elapsedMs > 0) {
      this.#tokens = Math.min(
        this.#capacity,
        this.#tokens + (elapsedMs * this.#capacity) / this.#intervalMs,
      );
      this.#lastRefillMs = now;
    }
    this.#tokens -= 1;
    if (this.#tokens >= 0) {
      return 0;
    }
    return (-this.#tokens * this.#intervalMs) / this.#capacity;
  }
}

function isRetryableStatus(status: number): boolean {
  // Composer resolution 3, read literally: retry on 429 and any 5xx, and *never* on any
  // other 4xx. 408 Request Timeout looks timeout-shaped and is tempting to fold into the
  // retryable set, but it's a 4xx the brief explicitly calls out as excluded — treating it
  // as an oversight rather than a deliberate exclusion would be re-litigating a resolution,
  // not implementing it.
  return status === 429 || (status >= 500 && status <= 599);
}

// Full jitter (AWS's "Exponential Backoff And Jitter"): draw the actual delay uniformly
// from [0, computedDelay] rather than computedDelay plus-or-minus some noise band. The
// plus-or-minus form still leaves every caller's delay clustered around the same center and
// retrying in near lockstep after an outage; sampling the full range is what actually
// decorrelates concurrent callers from each other.
function computeExponentialDelayMs(retryCount: number, retry: RetryConfig): number {
  const exponential = retry.baseDelayMs * 2 ** (retryCount - 1);
  return Math.min(exponential, retry.maxDelayMs);
}

function fullJitterDelayMs(computedDelayMs: number, jitter: () => number): number {
  return jitter() * computedDelayMs;
}

// Retry-After has two wire forms (RFC 9110 §10.2.3): delta-seconds ("120") or an HTTP-date
// ("Wed, 21 Oct 2026 07:28:00 GMT"). An unparseable value must fall back to computed
// backoff rather than throw — a malformed header from a misbehaving server is not a reason
// to crash the caller. The result is always clamped to `maxDelayMs` so a hostile or buggy
// server returning an absurd value (or a date far in the future) can't stall the pipeline
// indefinitely.
function parseRetryAfterMs(
  headerValue: string | null,
  nowMs: number,
  maxDelayMs: number,
): number | undefined {
  if (headerValue === null) {
    return undefined;
  }
  const trimmed = headerValue.trim();
  if (/^\d+$/.test(trimmed)) {
    return Math.min(Number(trimmed) * 1000, maxDelayMs);
  }
  const dateMs = Date.parse(trimmed);
  if (Number.isNaN(dateMs)) {
    return undefined;
  }
  return Math.min(Math.max(dateMs - nowMs, 0), maxDelayMs);
}

// AbortSignal.timeout()'s abort reason is a DOMException named "TimeoutError" per the
// fetch/AbortSignal spec (verified against Node 22's implementation), but a fake transport
// in tests may reasonably throw a plain Error with the same `name` instead of constructing
// a real DOMException. Checking `.name` by duck typing rather than `instanceof DOMException`
// covers both without the test suite needing to reach for a spec-exact type.
function isTimeoutFailure(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'name' in err &&
    (err as { name: unknown }).name === 'TimeoutError'
  );
}

interface ResolvedClient {
  readonly rateLimits: Readonly<Record<string, RateLimitConfig>>;
  readonly retry: RetryConfig;
  readonly defaultTimeoutMs: number;
  readonly transport: Transport;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly jitter: () => number;
  readonly buckets: Map<string, TokenBucket>;
}

function acquireRateLimitDelayMs(client: ResolvedClient, hostname: string): number {
  const config = client.rateLimits[hostname];
  if (config === undefined) {
    return 0;
  }
  let bucket = client.buckets.get(hostname);
  if (bucket === undefined) {
    bucket = new TokenBucket(config, client.now);
    client.buckets.set(hostname, bucket);
  }
  return bucket.acquireDelayMs();
}

async function performRequest(
  client: ResolvedClient,
  url: string,
  options: NetRequestOptions,
): Promise<Response> {
  const parsedUrl = new URL(url);
  const hostname = parsedUrl.hostname;
  const method = options.method ?? 'GET';
  const timeoutMs = options.timeoutMs ?? client.defaultTimeoutMs;

  for (let attempt = 1; ; attempt++) {
    const rateLimitDelayMs = acquireRateLimitDelayMs(client, hostname);
    if (rateLimitDelayMs > 0) {
      await client.sleep(rateLimitDelayMs);
    }

    const startedAtMs = client.now();
    let response: Response | undefined;
    let caughtError: unknown;
    try {
      response = await client.transport(url, {
        method,
        headers: options.headers,
        body: options.body ?? undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      caughtError = err;
    }
    const elapsedMs = client.now() - startedAtMs;

    if (response === undefined) {
      const timedOut = isTimeoutFailure(caughtError);
      // Never log the request body or headers (Reddit's OAuth credentials travel through
      // this path per I-04) — CLAUDE.md global rule 5, and resolution 7 of this task's
      // brief. `path`, not the full URL, so a query string never reaches the log either.
      log.warn('outbound request failed', {
        host: hostname,
        path: parsedUrl.pathname,
        method,
        attempt,
        elapsedMs,
        outcome: timedOut ? 'timeout' : 'network_error',
      });
      if (attempt >= client.retry.maxAttempts) {
        if (timedOut) {
          throw new TimeoutError(`Request to ${hostname} timed out after ${timeoutMs}ms`, {
            context: { host: hostname, path: parsedUrl.pathname, attempt, timeoutMs },
            cause: caughtError,
          });
        }
        throw new NetworkError(`Request to ${hostname} failed`, {
          context: { host: hostname, path: parsedUrl.pathname, attempt },
          cause: caughtError,
        });
      }
      const delayMs = fullJitterDelayMs(computeExponentialDelayMs(attempt, client.retry), client.jitter);
      await client.sleep(delayMs);
      continue;
    }

    const status = response.status;
    log.info('outbound request completed', {
      host: hostname,
      path: parsedUrl.pathname,
      method,
      status,
      attempt,
      elapsedMs,
    });

    if (!isRetryableStatus(status) || attempt >= client.retry.maxAttempts) {
      // The rule (composer resolution, task-R-04-brief.md): this module throws when it
      // gave up, and returns a Response when the server gave a definitive answer. A 429 or
      // 5xx that survives every retry means this module gave up, not that the server
      // answered definitively, so both become typed, catchable errors — the same way
      // NetworkError and TimeoutError already are — rather than a Response every caller
      // must remember to inspect for a bad status. I-05's orchestrator depends on this: a
      // broken upstream has to surface as something catchable so a failing source can be
      // recorded as PARTIAL instead of silently reading as a successful exchange.
      //
      // A non-retryable 4xx is the opposite case: it *is* the server's definitive answer,
      // just one the caller must interpret (I-02 needs a deleted HN item's 404 to read as
      // an ordinary response, not a thrown exception), so 4xx keeps returning a Response.
      if (status === 429) {
        throw new RateLimitError(`Rate limited by ${hostname} after ${attempt} attempts`, {
          context: { host: hostname, path: parsedUrl.pathname, attempt, status },
        });
      }
      if (status >= 500 && status <= 599) {
        throw new UpstreamError(`${hostname} returned ${status} after ${attempt} attempts`, {
          context: { host: hostname, path: parsedUrl.pathname, attempt, status },
        });
      }
      return response;
    }

    const retryAfterMs = parseRetryAfterMs(
      response.headers.get('retry-after'),
      client.now(),
      client.retry.maxDelayMs,
    );
    const delayMs =
      retryAfterMs ?? fullJitterDelayMs(computeExponentialDelayMs(attempt, client.retry), client.jitter);
    await client.sleep(delayMs);
  }
}

/**
 * Builds an isolated `NetClient` — its own token buckets, its own injected clock/sleep/
 * jitter/transport. Tests build one per case so state never leaks between them; production
 * code should generally import the ready-made `netClient` below instead, since rate
 * limiting only works when every call for a host shares one bucket.
 */
export function createNetClient(options: NetClientOptions = {}): NetClient {
  const client: ResolvedClient = {
    rateLimits: { ...DEFAULT_RATE_LIMITS, ...options.rateLimits },
    retry: { ...DEFAULT_RETRY, ...options.retry },
    defaultTimeoutMs: options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS,
    transport: options.transport ?? ((requestUrl, init) => fetch(requestUrl, init)),
    now: options.now ?? Date.now,
    sleep: options.sleep ?? defaultSleep,
    jitter: options.jitter ?? Math.random,
    buckets: new Map(),
  };

  return {
    request: (url, requestOptions = {}) => performRequest(client, url, requestOptions),
  };
}

/**
 * The client every source adapter should import directly — real timers, real jitter, and
 * this module's default rate limits and retry policy. `createNetClient` exists for tests
 * and for any future caller that genuinely needs isolated token-bucket state rather than
 * sharing this singleton's.
 */
export const netClient: NetClient = createNetClient();
