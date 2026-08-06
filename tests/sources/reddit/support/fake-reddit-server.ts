// A small, stateful fake Reddit — the "tests must not touch the network" seam (shared
// context resolution 3) for tests that exercise the full adapter, not just one of its
// pieces. Routes token requests separately from data requests, and can simulate a token
// expiring after a configurable number of successful data requests — the mechanism
// tests/sources/reddit/adapter.test.ts's "token expiry mid-run" test (composer resolution
// 2, the hard part of criterion 1) is built on.
import type { Transport } from '../../../../lib/net.js';

export interface RouteResult {
  readonly body: unknown;
  readonly status?: number;
  readonly headers?: Readonly<Record<string, string>>;
}

/** Given the parsed request URL, returns the fixture-backed response for it, or `undefined`
 *  if this server has no route configured for it (an unrouted request is a test-authoring
 *  bug, not a condition under test, so it throws rather than silently 404ing). */
export type Router = (url: URL) => RouteResult | Response | undefined;

export interface FakeRedditServerOptions {
  readonly tokenUrl: string;
  readonly route: Router;
  /** Number of successful oauth.reddit.com requests the *current* token remains valid for
   *  before this fake server starts 401ing it, simulating expiry. Omitted (the default)
   *  means the token never expires — the right default for tests that are not exercising
   *  composer resolution 2's mid-run expiry path specifically. */
  readonly tokenUsesBeforeExpiry?: number;
  /** Rate-limit headers stamped on every successful oauth.reddit.com response, in the
   *  shape criterion 4 reads. Overridable per test; a fixed default keeps most tests from
   *  needing to care. */
  readonly rateLimitHeaders?: Readonly<Record<string, string>>;
}

export interface FakeRedditServer {
  readonly transport: Transport;
  readonly tokenMintCount: () => number;
  readonly calls: () => readonly { url: string; init: RequestInit }[];
}

const DEFAULT_RATE_LIMIT_HEADERS: Readonly<Record<string, string>> = {
  'x-ratelimit-remaining': '99',
  'x-ratelimit-used': '1',
  'x-ratelimit-reset': '580',
};

export function createFakeRedditServer(options: FakeRedditServerOptions): FakeRedditServer {
  const calls: { url: string; init: RequestInit }[] = [];
  let tokenMintCount = 0;
  let currentToken: string | undefined;
  let usesRemaining = options.tokenUsesBeforeExpiry ?? Infinity;

  const transport: Transport = async (url, init) => {
    calls.push({ url, init });

    if (url === options.tokenUrl) {
      tokenMintCount += 1;
      currentToken = `fake-token-${tokenMintCount}`;
      usesRemaining = options.tokenUsesBeforeExpiry ?? Infinity;
      return new Response(JSON.stringify({ access_token: currentToken, token_type: 'bearer', expires_in: 3600 }), {
        status: 200,
      });
    }

    const headers = init.headers as Record<string, string> | undefined;
    const authorized = headers?.Authorization === `Bearer ${currentToken}`;
    if (!authorized || usesRemaining <= 0) {
      return new Response(null, { status: 401 });
    }
    usesRemaining -= 1;

    const result = options.route(new URL(url));
    if (result === undefined) {
      throw new Error(`createFakeRedditServer: no route configured for ${url}`);
    }
    if (result instanceof Response) {
      return result;
    }
    return new Response(JSON.stringify(result.body), {
      status: result.status ?? 200,
      headers: { ...DEFAULT_RATE_LIMIT_HEADERS, ...options.rateLimitHeaders, ...result.headers },
    });
  };

  return { transport, tokenMintCount: () => tokenMintCount, calls: () => calls };
}
