// The one place every authenticated oauth.reddit.com call in this adapter goes through —
// centralizing the reactive half of composer resolution 2 ("a token expiring between two
// paginated requests must refresh and continue, not surface as an error") here means
// ./adapter.ts's listing/comment/health-probe call sites never have to remember the retry
// themselves.
import type { NetClient } from '../../lib/net.js';
import type { TokenManager } from './auth.js';
import type { RedditRateLimitHeadroom } from './types.js';

export interface RequestAuthedOptions {
  readonly netClient: NetClient;
  readonly tokens: TokenManager;
  readonly userAgent: string;
}

export interface AuthedResponse {
  readonly response: Response;
  readonly headroom: RedditRateLimitHeadroom | undefined;
}

function parseNumericHeader(response: Response, name: string): number | undefined {
  const raw = response.headers.get(name);
  if (raw === null) {
    return undefined;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

/** Criterion 4: read straight off Reddit's own rate-limit response headers, present on
 *  every oauth.reddit.com response, not just error ones. */
export function parseRateLimitHeadroom(response: Response): RedditRateLimitHeadroom | undefined {
  const remaining = parseNumericHeader(response, 'x-ratelimit-remaining');
  const used = parseNumericHeader(response, 'x-ratelimit-used');
  const resetSeconds = parseNumericHeader(response, 'x-ratelimit-reset');
  if (remaining === undefined && used === undefined && resetSeconds === undefined) {
    return undefined;
  }
  return { remaining, used, resetSeconds };
}

/**
 * GETs an oauth.reddit.com URL with a bearer token, transparently refreshing and retrying
 * exactly once on a 401 (composer resolution 2). A 401 that survives the retry means the
 * credentials themselves are bad, not merely stale — this function does not decide that;
 * it hands back the still-401 `Response` like any other non-retryable-4xx, and the caller
 * (./adapter.ts) is the one that turns a persistent 401 into a thrown `ConfigError`, the
 * same way every other non-2xx branch in this adapter is the caller's own status check per
 * lib/net.ts's "non-retryable 4xx returns the Response" contract. Only lib/net.ts's own
 * retries-exhausted cases (429/5xx/network/timeout) surface here as a thrown `AppError`,
 * propagated unchanged — nothing in this function catches those.
 */
export async function requestAuthed(url: string, options: RequestAuthedOptions): Promise<AuthedResponse> {
  const attempt = async (): Promise<Response> => {
    const token = await options.tokens.getToken();
    // Never log this header — lib/net.ts deliberately never logs request headers, precisely
    // so this Authorization value (and the client secret behind minting it) never reaches a
    // log line (CLAUDE.md rule 5; composer resolution 3).
    return options.netClient.request(url, {
      headers: { Authorization: `Bearer ${token}`, 'User-Agent': options.userAgent },
    });
  };

  let response = await attempt();
  if (response.status === 401) {
    options.tokens.invalidate();
    response = await attempt();
  }
  return { response, headroom: parseRateLimitHeadroom(response) };
}
