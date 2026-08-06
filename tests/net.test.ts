import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_RATE_LIMITS,
  createNetClient,
  netClient,
  type Transport,
} from '../lib/net.js';
import { NetworkError, RateLimitError, TimeoutError, UpstreamError } from '../lib/errors.js';

// A queue of canned responses/errors, one per call, so a test can script exactly what each
// attempt sees (e.g. "500, then 500, then 200") without a real server.
function makeTransport(script: ReadonlyArray<Response | Error>): {
  transport: Transport;
  calls: Array<{ url: string; init: RequestInit }>;
} {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let index = 0;
  const transport: Transport = async (url, init) => {
    calls.push({ url, init });
    const next = script[index++];
    if (next === undefined) {
      // A test wiring bug (too few scripted responses for the attempts made), not a
      // condition under test — constructing via AppError isn't warranted here since this
      // never reaches production code, and tests/** is exempt from the construction ban.
      throw new Error('makeTransport: script exhausted');
    }
    if (next instanceof Error) {
      throw next;
    }
    return next;
  };
  return { transport, calls };
}

// Records every delay `performRequest` asks the client to wait, without actually waiting —
// this is the injected seam (composer resolution 1) that lets backoff/rate-limit tests
// assert an exact delay sequence instead of either sleeping for real or asserting nothing.
function recordSleeps(): { sleep: (ms: number) => Promise<void>; delays: number[] } {
  const delays: number[] = [];
  return {
    sleep: async (ms: number) => {
      delays.push(ms);
    },
    delays,
  };
}

// Mirrors tests/log.test.ts's own helper (not exported from there, so duplicated here) —
// captures the structured logger's raw stdout writes for inspection.
function captureStdoutWrites(): { lines: () => string[]; restore: () => void } {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  });
  return { lines: () => chunks, restore: () => spy.mockRestore() };
}

describe('createNetClient', () => {
  describe('successful requests', () => {
    it('returns the response with no retry when the first attempt succeeds', async () => {
      const { transport, calls } = makeTransport([new Response('ok', { status: 200 })]);
      const { sleep, delays } = recordSleeps();
      const client = createNetClient({ transport, sleep, now: () => 0 });

      const res = await client.request('https://example.com/x');

      expect(res.status).toBe(200);
      expect(calls).toHaveLength(1);
      expect(delays).toEqual([]);
    });
  });

  describe('backoff timing (criterion: "Tests cover: backoff timing")', () => {
    it('computes exponential-with-full-jitter delays for each retry, in attempt order', async () => {
      const { transport } = makeTransport([
        new Response(null, { status: 500 }),
        new Response(null, { status: 500 }),
        new Response(null, { status: 500 }),
        new Response('ok', { status: 200 }),
      ]);
      const { sleep, delays } = recordSleeps();
      const client = createNetClient({
        transport,
        sleep,
        now: () => 0,
        jitter: () => 0.5,
        retry: { maxAttempts: 4, baseDelayMs: 100, maxDelayMs: 10_000 },
      });

      const res = await client.request('https://example.com/x');

      expect(res.status).toBe(200);
      // Full jitter draws from [0, base * 2^(attempt-1)]; jitter fixed at 0.5 makes each
      // delay exactly half of the computed exponential ceiling: 100, 200, 400 -> 50, 100, 200.
      expect(delays).toEqual([50, 100, 200]);
    });

    it('draws from the full [0, computedDelay] range, not computedDelay plus-or-minus noise', async () => {
      const { transport } = makeTransport([
        new Response(null, { status: 500 }),
        new Response('ok', { status: 200 }),
      ]);
      const { sleep, delays } = recordSleeps();
      const client = createNetClient({
        transport,
        sleep,
        now: () => 0,
        jitter: () => 0, // the low end of full jitter's range
        retry: { maxAttempts: 2, baseDelayMs: 100, maxDelayMs: 10_000 },
      });

      await client.request('https://example.com/x');

      // A "computedDelay +/- noise" implementation could never reach 0; full jitter can.
      expect(delays).toEqual([0]);
    });

    it('clamps the computed exponential delay to maxDelayMs', async () => {
      const { transport } = makeTransport([
        new Response(null, { status: 500 }),
        new Response(null, { status: 500 }),
        new Response(null, { status: 500 }),
        new Response('ok', { status: 200 }),
      ]);
      const { sleep, delays } = recordSleeps();
      const client = createNetClient({
        transport,
        sleep,
        now: () => 0,
        jitter: () => 1, // the high end, so the clamp is what's under test
        retry: { maxAttempts: 4, baseDelayMs: 100, maxDelayMs: 250 },
      });

      await client.request('https://example.com/x');

      // Unclamped this would be [100, 200, 400]; the third is capped to maxDelayMs.
      expect(delays).toEqual([100, 200, 250]);
    });

    it('retries a network-level failure with the same backoff schedule, then throws NetworkError', async () => {
      let callCount = 0;
      const transport: Transport = async () => {
        callCount += 1;
        throw new Error('ECONNREFUSED');
      };
      const { sleep, delays } = recordSleeps();
      const client = createNetClient({
        transport,
        sleep,
        now: () => 0,
        jitter: () => 0.5,
        retry: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 10_000 },
      });

      await expect(client.request('https://example.com/x')).rejects.toThrow(NetworkError);
      expect(callCount).toBe(3);
      expect(delays).toEqual([50, 100]);
    });
  });

  describe('rate-limit enforcement (criterion: "Tests cover: rate-limit enforcement")', () => {
    it('lets requests through immediately up to the bucket capacity, then delays', async () => {
      const { transport } = makeTransport([
        new Response('a', { status: 200 }),
        new Response('b', { status: 200 }),
        new Response('c', { status: 200 }),
      ]);
      const { sleep, delays } = recordSleeps();
      const client = createNetClient({
        transport,
        sleep,
        now: () => 0, // a fixed clock: no real time passes between these calls
        rateLimits: { 'example.com': { limit: 2, intervalMs: 1000 } },
      });

      await client.request('https://example.com/a');
      await client.request('https://example.com/b');
      await client.request('https://example.com/c');

      // Capacity 2 covers the first two requests for free; the third needs one more token,
      // which at 2 tokens/1000ms refills in 500ms.
      expect(delays).toEqual([500]);
    });

    it('refills tokens as the injected clock advances, so a later request needs no delay', async () => {
      const { transport } = makeTransport([
        new Response('a', { status: 200 }),
        new Response('b', { status: 200 }),
      ]);
      const { sleep, delays } = recordSleeps();
      let now = 0;
      const client = createNetClient({
        transport,
        sleep,
        now: () => now,
        rateLimits: { 'example.com': { limit: 1, intervalMs: 1000 } },
      });

      await client.request('https://example.com/a');
      now += 1000;
      await client.request('https://example.com/b');

      expect(delays).toEqual([]);
    });

    it('does not rate-limit a host absent from the configured map', async () => {
      const { transport } = makeTransport([
        new Response('a', { status: 200 }),
        new Response('b', { status: 200 }),
        new Response('c', { status: 200 }),
      ]);
      const { sleep, delays } = recordSleeps();
      const client = createNetClient({ transport, sleep, now: () => 0, rateLimits: {} });

      await client.request('https://unconfigured.example.com/a');
      await client.request('https://unconfigured.example.com/b');
      await client.request('https://unconfigured.example.com/c');

      expect(delays).toEqual([]);
    });

    it('defaults oauth.reddit.com to exactly 100 requests per 60 seconds', () => {
      expect(DEFAULT_RATE_LIMITS['oauth.reddit.com']).toEqual({
        limit: 100,
        intervalMs: 60_000,
      });
    });

    it('keeps the Reddit default active when the caller adds an unrelated host limit', async () => {
      const script: Response[] = Array.from({ length: 101 }, () => new Response(null, { status: 200 }));
      const { transport } = makeTransport(script);
      const { sleep, delays } = recordSleeps();
      const client = createNetClient({
        transport,
        sleep,
        now: () => 0,
        rateLimits: { 'example.com': { limit: 5, intervalMs: 1000 } },
      });

      for (let i = 0; i < 100; i++) {
        await client.request('https://oauth.reddit.com/api/v1/me');
      }
      expect(delays).toEqual([]);

      await client.request('https://oauth.reddit.com/api/v1/me');
      // 101st request against a 100/60_000ms bucket needs one token's worth of refill time.
      expect(delays).toEqual([600]);
    });
  });

  describe('Retry-After handling (criterion: "Tests cover: Retry-After handling")', () => {
    it('honors a delta-seconds Retry-After over the computed backoff', async () => {
      const { transport } = makeTransport([
        new Response(null, { status: 429, headers: { 'retry-after': '2' } }),
        new Response('ok', { status: 200 }),
      ]);
      const { sleep, delays } = recordSleeps();
      const client = createNetClient({
        transport,
        sleep,
        now: () => 0,
        jitter: () => 1, // would make computed backoff the max (100ms) if wrongly used instead
        retry: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 30_000 },
      });

      await client.request('https://example.com/x');

      expect(delays).toEqual([2000]);
    });

    it('honors an HTTP-date Retry-After, computed against the injected clock', async () => {
      const nowMs = Date.UTC(2026, 0, 1, 0, 0, 0);
      const retryAfterDate = new Date(nowMs + 5000).toUTCString();
      const { transport } = makeTransport([
        new Response(null, { status: 429, headers: { 'retry-after': retryAfterDate } }),
        new Response('ok', { status: 200 }),
      ]);
      const { sleep, delays } = recordSleeps();
      const client = createNetClient({
        transport,
        sleep,
        now: () => nowMs,
        jitter: () => 1,
        retry: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 30_000 },
      });

      await client.request('https://example.com/x');

      expect(delays).toEqual([5000]);
    });

    it('falls back to computed backoff when Retry-After is unparseable, rather than throwing', async () => {
      const { transport } = makeTransport([
        new Response(null, { status: 429, headers: { 'retry-after': 'not-a-real-value' } }),
        new Response('ok', { status: 200 }),
      ]);
      const { sleep, delays } = recordSleeps();
      const client = createNetClient({
        transport,
        sleep,
        now: () => 0,
        jitter: () => 0.5,
        retry: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 30_000 },
      });

      await expect(client.request('https://example.com/x')).resolves.toMatchObject({ status: 200 });
      expect(delays).toEqual([50]);
    });

    it('clamps an absurdly large delta-seconds Retry-After to maxDelayMs', async () => {
      const { transport } = makeTransport([
        new Response(null, { status: 429, headers: { 'retry-after': '999999999' } }),
        new Response('ok', { status: 200 }),
      ]);
      const { sleep, delays } = recordSleeps();
      const client = createNetClient({
        transport,
        sleep,
        now: () => 0,
        retry: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 5000 },
      });

      await client.request('https://example.com/x');

      expect(delays).toEqual([5000]);
    });

    it('clamps a far-future Retry-After HTTP-date to maxDelayMs', async () => {
      const nowMs = 0;
      const farFuture = new Date(nowMs + 999_999_999).toUTCString();
      const { transport } = makeTransport([
        new Response(null, { status: 429, headers: { 'retry-after': farFuture } }),
        new Response('ok', { status: 200 }),
      ]);
      const { sleep, delays } = recordSleeps();
      const client = createNetClient({
        transport,
        sleep,
        now: () => nowMs,
        retry: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 5000 },
      });

      await client.request('https://example.com/x');

      expect(delays).toEqual([5000]);
    });
  });

  describe('timeout (criterion: "Tests cover: ... timeout")', () => {
    it('throws TimeoutError, distinct from NetworkError, via a real AbortSignal.timeout', async () => {
      // A genuinely slow transport that respects the abort signal the way the real fetch
      // default transport does — this exercises the actual Node AbortSignal.timeout()
      // mechanism (composer resolution 6) rather than faking the rejection shape, while
      // keeping the test fast: timeoutMs below is 15ms of real wall-clock time, not seconds.
      const transport: Transport = (_url, init) =>
        new Promise((resolve, reject) => {
          const late = setTimeout(() => resolve(new Response('too late', { status: 200 })), 2000);
          init.signal?.addEventListener('abort', () => {
            clearTimeout(late);
            reject(init.signal?.reason);
          });
        });
      const { sleep } = recordSleeps();
      const client = createNetClient({
        transport,
        sleep,
        now: () => 0,
        retry: { maxAttempts: 1, baseDelayMs: 10, maxDelayMs: 100 },
      });

      await expect(client.request('https://example.com/x', { timeoutMs: 15 })).rejects.toThrow(
        TimeoutError,
      );
    });

    it('does not classify a non-timeout transport failure as TimeoutError', async () => {
      const transport: Transport = async () => {
        throw new Error('ECONNREFUSED');
      };
      const { sleep } = recordSleeps();
      const client = createNetClient({
        transport,
        sleep,
        now: () => 0,
        retry: { maxAttempts: 1, baseDelayMs: 10, maxDelayMs: 100 },
      });

      const err = await client.request('https://example.com/x').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(NetworkError);
      expect(err).not.toBeInstanceOf(TimeoutError);
    });
  });

  describe('retry policy: 429, 5xx, and network errors only (criterion: "Retries only on 429, 5xx, and network errors")', () => {
    it.each([429, 500, 502, 503, 599])('retries a %i response up to maxAttempts', async (status) => {
      const { transport, calls } = makeTransport([
        new Response(null, { status }),
        new Response('ok', { status: 200 }),
      ]);
      const { sleep } = recordSleeps();
      const client = createNetClient({
        transport,
        sleep,
        now: () => 0,
        retry: { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 1000 },
      });

      const res = await client.request('https://example.com/x');

      expect(res.status).toBe(200);
      expect(calls).toHaveLength(2);
    });

    // 408 is deliberately included here, not as an oversight: composer resolution 3 reads
    // "never on 4xx other than 429" literally, and 408 is a 4xx.
    it.each([400, 401, 403, 404, 408])('never retries a %i response', async (status) => {
      const { transport, calls } = makeTransport([new Response(null, { status })]);
      const { sleep, delays } = recordSleeps();
      const client = createNetClient({
        transport,
        sleep,
        now: () => 0,
        retry: { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 1000 },
      });

      const res = await client.request('https://example.com/x');

      expect(res.status).toBe(status);
      expect(calls).toHaveLength(1);
      expect(delays).toEqual([]);
    });

    it('throws RateLimitError when 429 persists through every retry', async () => {
      const transport: Transport = async () => new Response(null, { status: 429 });
      const { sleep } = recordSleeps();
      const client = createNetClient({
        transport,
        sleep,
        now: () => 0,
        retry: { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100 },
      });

      await expect(client.request('https://example.com/x')).rejects.toThrow(RateLimitError);
    });

    it('throws UpstreamError, not RateLimitError, when a 5xx persists through every retry', async () => {
      // Composer resolution (task-R-04-brief.md): net.ts throws when it gave up and returns
      // a Response only when the server gave a definitive answer. An exhausted 5xx is this
      // module giving up — see the comment in lib/net.ts next to this branch — so it must
      // surface as a catchable error, the same way an exhausted 429 already does, rather
      // than as a Response every caller has to remember to inspect.
      const { transport, calls } = makeTransport([
        new Response(null, { status: 503 }),
        new Response(null, { status: 503 }),
        new Response(null, { status: 503 }),
      ]);
      const { sleep } = recordSleeps();
      const client = createNetClient({
        transport,
        sleep,
        now: () => 0,
        retry: { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100 },
      });

      const err = await client.request('https://example.com/x').catch((e: unknown) => e);

      expect(err).toBeInstanceOf(UpstreamError);
      expect(err).not.toBeInstanceOf(RateLimitError);
      expect((err as UpstreamError).context).toMatchObject({
        host: 'example.com',
        path: '/x',
        attempt: 3,
        status: 503,
      });
      // Retry counts are unchanged by this task: still exactly maxAttempts calls before
      // giving up, whether giving up now throws or (as before) returned a Response.
      expect(calls).toHaveLength(3);
    });
  });

  describe('structured request logging', () => {
    it('logs host, method, status, attempt, and elapsed duration; never the query string, body, or Authorization header', async () => {
      const capture = captureStdoutWrites();
      const transport: Transport = async () => new Response('ok', { status: 200 });
      const { sleep } = recordSleeps();
      const client = createNetClient({ transport, sleep, now: () => 0 });

      await client.request('https://example.com/path?token=super-secret-value', {
        method: 'POST',
        headers: { Authorization: 'Bearer super-secret-value' },
        body: JSON.stringify({ secret: 'super-secret-value' }),
      });

      const lines = capture.lines();
      capture.restore();
      const joined = lines.join('\n');

      expect(joined).not.toContain('super-secret-value');
      expect(joined).not.toContain('token=');
      expect(joined).not.toContain('Authorization');

      const record = JSON.parse(lines[lines.length - 1] ?? '') as Record<string, unknown>;
      expect(record.host).toBe('example.com');
      expect(record.path).toBe('/path');
      expect(record.method).toBe('POST');
      expect(record.status).toBe(200);
      expect(record.attempt).toBe(1);
      expect(typeof record.elapsedMs).toBe('number');
    });

    it('logs a failed attempt (host, method, attempt, elapsed duration, outcome) without a status', async () => {
      const capture = captureStdoutWrites();
      const transport: Transport = async () => {
        throw new Error('ECONNREFUSED');
      };
      const { sleep } = recordSleeps();
      const client = createNetClient({
        transport,
        sleep,
        now: () => 0,
        retry: { maxAttempts: 1, baseDelayMs: 10, maxDelayMs: 100 },
      });

      await client.request('https://example.com/path').catch(() => undefined);

      const lines = capture.lines();
      capture.restore();
      const record = JSON.parse(lines[lines.length - 1] ?? '') as Record<string, unknown>;
      expect(record.host).toBe('example.com');
      expect(record.method).toBe('GET');
      expect(record.attempt).toBe(1);
      expect(typeof record.elapsedMs).toBe('number');
      expect(record.outcome).toBe('network_error');
      expect('status' in record).toBe(false);
    });
  });

  describe('the ready-made default client', () => {
    it('is exported and exposes the NetClient interface', () => {
      expect(typeof netClient.request).toBe('function');
    });
  });
});
