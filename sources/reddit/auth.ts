// OAuth token lifecycle for the Reddit adapter. Kept in its own module so the
// proactive-expiry-check logic (composer resolution 2: "a token expiring between two
// paginated requests must refresh and continue, not surface as an error") lives in exactly
// one place, shared by every authenticated call ./adapter.ts makes — listing pages, comment
// threads, and the health probe alike — instead of duplicated at each call site. The
// complementary *reactive* half (retrying once on an actual 401) lives in ./http.ts, which
// calls back into `invalidate()` below; this module owns minting and caching, not retrying.
import type { NetClient } from '../../lib/net.js';
import { ConfigError, UpstreamError } from '../../lib/errors.js';

export interface RedditAuthOptions {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly userAgent: string;
  readonly netClient: NetClient;
  /** Overridable so tests can point at a fake token host instead of www.reddit.com. */
  readonly tokenUrl?: string;
  /** Injectable clock (epoch ms), defaults to `Date.now`. */
  readonly now?: () => number;
}

export interface TokenManager {
  /** Returns a currently-valid access token, minting or refreshing first if necessary. */
  getToken(): Promise<string>;
  /** Discards any cached token, forcing the next `getToken()` call to mint a new one — used
   *  after a 401 on a token that looked unexpired by the clock (composer resolution 2's
   *  reactive path, driven from ./http.ts). */
  invalidate(): void;
}

const DEFAULT_TOKEN_URL = 'https://www.reddit.com/api/v1/access_token';

// Refresh a little before the token's own reported expiry rather than exactly at it. A
// zero-margin proactive check can still lose the race against Reddit's clock, or against the
// time this process takes between reading `now()` and the request actually landing — that
// residual gap is exactly what ./http.ts's reactive 401-retry exists to catch, so this skew
// just makes that fallback path the exception rather than the norm.
const EXPIRY_SKEW_MS = 30_000;

// Reddit's documented token lifetime; used only as a conservative fallback if a token
// response is missing (or has a malformed) `expires_in` — see `extractExpiresIn` below.
const FALLBACK_EXPIRES_IN_SECONDS = 3600;

interface CachedToken {
  readonly accessToken: string;
  readonly expiresAtMs: number;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}

function extractAccessToken(json: unknown): string {
  const record = asRecord(json);
  const accessToken = record?.access_token;
  if (typeof accessToken === 'string' && accessToken !== '') {
    return accessToken;
  }
  throw new UpstreamError('Reddit OAuth token response was missing a string access_token', {
    context: { host: 'www.reddit.com' },
  });
}

function extractExpiresIn(json: unknown): number {
  const record = asRecord(json);
  const expiresIn = record?.expires_in;
  if (typeof expiresIn === 'number' && Number.isFinite(expiresIn) && expiresIn > 0) {
    return expiresIn;
  }
  return FALLBACK_EXPIRES_IN_SECONDS;
}

async function mintToken(options: RedditAuthOptions): Promise<CachedToken> {
  const basicAuth = Buffer.from(`${options.clientId}:${options.clientSecret}`).toString('base64');
  const body = new URLSearchParams({ grant_type: 'client_credentials' });
  const res = await options.netClient.request(options.tokenUrl ?? DEFAULT_TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basicAuth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': options.userAgent,
    },
    body: body.toString(),
  });
  // A non-retryable 4xx here means Reddit rejected the app's own client_id/secret pair —
  // lib/net.ts returns that as an ordinary Response (the "definitive answer" row of its
  // contract table), not an exception, so this is the adapter's own status check, the same
  // way I-01's illustrative Hacker News example branches on a 404. Never read or log the
  // response body: there is no upside to ever surfacing upstream error-response content
  // here, only downside if its shape ever changes to echo something it shouldn't.
  if (!res.ok) {
    throw new ConfigError(
      `Reddit OAuth token request failed with status ${res.status} — check REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET`,
      { context: { status: res.status } },
    );
  }
  const json: unknown = await res.json();
  const accessToken = extractAccessToken(json);
  const expiresInSeconds = extractExpiresIn(json);
  const now = (options.now ?? Date.now)();
  return { accessToken, expiresAtMs: now + expiresInSeconds * 1000 };
}

/**
 * Token state lives in this closure (composer resolution 2: "Hold token state in the
 * factory closure") — one `TokenManager` per adapter instance, reused across every
 * `fetchIncremental` / `fetchBackfill` / `checkHealth` call that instance ever makes, so a
 * token minted on call 1 is still the one reused — or transparently refreshed — on call 50,
 * instead of every call re-authenticating from scratch (which would also multiply
 * www.reddit.com traffic for no benefit).
 */
export function createTokenManager(options: RedditAuthOptions): TokenManager {
  let cached: CachedToken | undefined;

  return {
    async getToken() {
      const now = (options.now ?? Date.now)();
      if (cached === undefined || now >= cached.expiresAtMs - EXPIRY_SKEW_MS) {
        cached = await mintToken(options);
      }
      return cached.accessToken;
    },
    invalidate() {
      cached = undefined;
    },
  };
}
