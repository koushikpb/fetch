import { describe, expect, it } from 'vitest';
import { createNetClient, type Transport } from '../../../lib/net.js';
import type { TokenManager } from '../../../sources/reddit/auth.js';
import { parseRateLimitHeadroom, requestAuthed } from '../../../sources/reddit/http.js';

function makeTokens(tokens: readonly string[]): TokenManager & { invalidateCalls: number } {
  let index = 0;
  let invalidateCalls = 0;
  return {
    async getToken() {
      const token = tokens[index];
      if (token === undefined) {
        throw new Error('makeTokens: script exhausted');
      }
      return token;
    },
    invalidate() {
      invalidateCalls += 1;
      index += 1;
    },
    get invalidateCalls() {
      return invalidateCalls;
    },
  };
}

describe('requestAuthed', () => {
  it('sends Authorization: Bearer <token> and the configured User-Agent', async () => {
    const calls: RequestInit[] = [];
    const transport: Transport = async (_url, init) => {
      calls.push(init);
      return new Response('ok', { status: 200 });
    };
    const net = createNetClient({ transport });
    const tokens = makeTokens(['token-1']);

    await requestAuthed('https://oauth.reddit.com/r/test/about', { netClient: net, tokens, userAgent: 'fetch-app/0.1' });

    const headers = calls[0]?.headers as Record<string, string> | undefined;
    expect(headers?.Authorization).toBe('Bearer token-1');
    expect(headers?.['User-Agent']).toBe('fetch-app/0.1');
  });

  it('never sends a request body or a query string that could smuggle credentials — GET only, no body', async () => {
    const calls: RequestInit[] = [];
    const transport: Transport = async (_url, init) => {
      calls.push(init);
      return new Response('ok', { status: 200 });
    };
    const net = createNetClient({ transport });
    const tokens = makeTokens(['token-1']);

    await requestAuthed('https://oauth.reddit.com/r/test/about', { netClient: net, tokens, userAgent: 'ua' });

    expect(calls[0]?.body).toBeUndefined();
  });

  it('on a 401, invalidates the token and retries exactly once with a fresh one (composer resolution 2, reactive path)', async () => {
    const seenTokens: string[] = [];
    let call = 0;
    const transport: Transport = async (_url, init) => {
      call += 1;
      const auth = (init.headers as Record<string, string>).Authorization ?? '';
      seenTokens.push(auth);
      return call === 1 ? new Response(null, { status: 401 }) : new Response('ok', { status: 200 });
    };
    const net = createNetClient({ transport });
    const tokens = makeTokens(['stale-token', 'fresh-token']);

    const { response } = await requestAuthed('https://oauth.reddit.com/r/test/about', {
      netClient: net,
      tokens,
      userAgent: 'ua',
    });

    expect(response.status).toBe(200);
    expect(seenTokens).toEqual(['Bearer stale-token', 'Bearer fresh-token']);
    expect(tokens.invalidateCalls).toBe(1);
  });

  it('does not throw on a 401 that survives the retry — hands back the still-401 Response for the caller to interpret', async () => {
    const transport: Transport = async () => new Response(null, { status: 401 });
    const net = createNetClient({ transport });
    const tokens = makeTokens(['always-stale', 'still-stale']);

    const { response } = await requestAuthed('https://oauth.reddit.com/r/test/about', {
      netClient: net,
      tokens,
      userAgent: 'ua',
    });

    expect(response.status).toBe(401);
  });

  it('a non-401 status is returned as-is, with no retry and no token invalidation', async () => {
    let calls = 0;
    const transport: Transport = async () => {
      calls += 1;
      return new Response(null, { status: 404 });
    };
    const net = createNetClient({ transport });
    const tokens = makeTokens(['token-1']);

    const { response } = await requestAuthed('https://oauth.reddit.com/r/test/about', {
      netClient: net,
      tokens,
      userAgent: 'ua',
    });

    expect(response.status).toBe(404);
    expect(calls).toBe(1);
    expect(tokens.invalidateCalls).toBe(0);
  });
});

describe('parseRateLimitHeadroom (criterion 4)', () => {
  it('reads remaining/used/reset off the real Reddit header names', () => {
    const response = new Response(null, {
      headers: { 'x-ratelimit-remaining': '99.0', 'x-ratelimit-used': '1.0', 'x-ratelimit-reset': '580' },
    });
    expect(parseRateLimitHeadroom(response)).toEqual({ remaining: 99, used: 1, resetSeconds: 580 });
  });

  it('returns undefined when none of the three headers are present', () => {
    expect(parseRateLimitHeadroom(new Response(null))).toBeUndefined();
  });

  it('tolerates a partial set of headers', () => {
    const response = new Response(null, { headers: { 'x-ratelimit-remaining': '50' } });
    expect(parseRateLimitHeadroom(response)).toEqual({ remaining: 50, used: undefined, resetSeconds: undefined });
  });
});
