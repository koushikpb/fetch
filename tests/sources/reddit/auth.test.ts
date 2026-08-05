// Token lifecycle only — the reactive 401-retry that completes composer resolution 2 lives
// in ./http.test.ts, since it belongs to requestAuthed, not createTokenManager.
import { describe, expect, it } from 'vitest';
import { createNetClient, type Transport } from '../../../lib/net.js';
import { ConfigError, UpstreamError } from '../../../lib/errors.js';
import { createTokenManager } from '../../../sources/reddit/auth.js';

interface RecordedCall {
  readonly url: string;
  readonly headers: Record<string, string> | undefined;
  readonly body: unknown;
}

function makeTokenTransport(script: ReadonlyArray<Response | Error>): {
  transport: Transport;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  let index = 0;
  const transport: Transport = async (url, init) => {
    calls.push({ url, headers: init.headers as Record<string, string> | undefined, body: init.body });
    const next = script[index++];
    if (next === undefined) {
      throw new Error('makeTokenTransport: script exhausted');
    }
    if (next instanceof Error) {
      throw next;
    }
    return next;
  };
  return { transport, calls };
}

function tokenResponse(overrides: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({ access_token: 'access-token-1', token_type: 'bearer', expires_in: 3600, ...overrides }),
    { status: 200 },
  );
}

const AUTH_BASE = { clientId: 'client-id-1', clientSecret: 'super-secret-value', userAgent: 'fetch-app/0.1 (by /u/test)' };

describe('createTokenManager', () => {
  it('mints a token via Basic auth + grant_type=client_credentials, and never sends the User-Agent-less default', async () => {
    const { transport, calls } = makeTokenTransport([tokenResponse()]);
    const net = createNetClient({ transport });
    const tokens = createTokenManager({ ...AUTH_BASE, netClient: net, now: () => 0 });

    const token = await tokens.getToken();

    expect(token).toBe('access-token-1');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://www.reddit.com/api/v1/access_token');
    const expectedBasic = Buffer.from(`${AUTH_BASE.clientId}:${AUTH_BASE.clientSecret}`).toString('base64');
    expect(calls[0]?.headers?.Authorization).toBe(`Basic ${expectedBasic}`);
    expect(calls[0]?.headers?.['User-Agent']).toBe(AUTH_BASE.userAgent);
    expect(calls[0]?.body).toBe('grant_type=client_credentials');
  });

  it('respects a custom tokenUrl (the seam tests use instead of the real www.reddit.com host)', async () => {
    const { transport, calls } = makeTokenTransport([tokenResponse()]);
    const net = createNetClient({ transport });
    const tokens = createTokenManager({
      ...AUTH_BASE,
      netClient: net,
      tokenUrl: 'https://fake-reddit-auth.test/token',
      now: () => 0,
    });

    await tokens.getToken();

    expect(calls[0]?.url).toBe('https://fake-reddit-auth.test/token');
  });

  it('caches the token across calls — a second getToken() before expiry makes no further request', async () => {
    const { transport, calls } = makeTokenTransport([tokenResponse()]);
    const net = createNetClient({ transport });
    let now = 0;
    const tokens = createTokenManager({ ...AUTH_BASE, netClient: net, now: () => now });

    const first = await tokens.getToken();
    now += 1000; // 1s later, nowhere near the 3600s expiry
    const second = await tokens.getToken();

    expect(first).toBe('access-token-1');
    expect(second).toBe('access-token-1');
    expect(calls).toHaveLength(1);
  });

  it('proactively refreshes once the clock crosses the expiry skew, without waiting for a 401 (composer resolution 2)', async () => {
    const { transport, calls } = makeTokenTransport([
      tokenResponse({ access_token: 'access-token-1' }),
      tokenResponse({ access_token: 'access-token-2' }),
    ]);
    const net = createNetClient({ transport });
    let now = 0;
    const tokens = createTokenManager({ ...AUTH_BASE, netClient: net, now: () => now });

    const first = await tokens.getToken();
    // 3600s expiry, 30s skew: crossing 3571s should trigger a proactive remint.
    now = 3571_000;
    const second = await tokens.getToken();

    expect(first).toBe('access-token-1');
    expect(second).toBe('access-token-2');
    expect(calls).toHaveLength(2);
  });

  it('invalidate() forces the next getToken() to mint a fresh token', async () => {
    const { transport, calls } = makeTokenTransport([
      tokenResponse({ access_token: 'access-token-1' }),
      tokenResponse({ access_token: 'access-token-2' }),
    ]);
    const net = createNetClient({ transport });
    const tokens = createTokenManager({ ...AUTH_BASE, netClient: net, now: () => 0 });

    const first = await tokens.getToken();
    tokens.invalidate();
    const second = await tokens.getToken();

    expect(first).toBe('access-token-1');
    expect(second).toBe('access-token-2');
    expect(calls).toHaveLength(2);
  });

  it('falls back to a conservative default lifetime when expires_in is missing or malformed', async () => {
    const { transport, calls } = makeTokenTransport([
      tokenResponse({ expires_in: undefined }),
      tokenResponse({ access_token: 'access-token-2' }),
    ]);
    const net = createNetClient({ transport });
    let now = 0;
    const tokens = createTokenManager({ ...AUTH_BASE, netClient: net, now: () => now });

    await tokens.getToken();
    now = 3571_000; // past the 3600s fallback minus skew
    await tokens.getToken();

    expect(calls).toHaveLength(2);
  });

  it('throws UpstreamError when the token response has no string access_token', async () => {
    const { transport } = makeTokenTransport([new Response(JSON.stringify({ token_type: 'bearer' }), { status: 200 })]);
    const net = createNetClient({ transport });
    const tokens = createTokenManager({ ...AUTH_BASE, netClient: net, now: () => 0 });

    await expect(tokens.getToken()).rejects.toThrow(UpstreamError);
  });

  it('throws ConfigError on a non-2xx token response, and never leaks the client secret into the error', async () => {
    const { transport } = makeTokenTransport([new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 401 })]);
    const net = createNetClient({ transport });
    const tokens = createTokenManager({ ...AUTH_BASE, netClient: net, now: () => 0 });

    let caught: unknown;
    try {
      await tokens.getToken();
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ConfigError);
    const serialized = JSON.stringify(caught, Object.getOwnPropertyNames(caught as object));
    expect(serialized).not.toContain(AUTH_BASE.clientSecret);
    expect((caught as ConfigError).message).not.toContain(AUTH_BASE.clientSecret);
    expect((caught as ConfigError).context).toEqual({ status: 401 });
  });
});
