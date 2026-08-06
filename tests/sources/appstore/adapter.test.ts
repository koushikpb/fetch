// Integration-style tests for the App Store adapter's fan-out, pagination-ceiling, cursor,
// and partial-failure behavior, run against a fake `Transport` (wave 3 shared context
// resolution 3: "tests must not touch the network"). tests/sources/appstore/ is exempted
// from eslint's adapter-deep-import ban specifically so this file can import
// sources/appstore/adapter.ts directly (see eslint.config.js's TESTS_GLOB override).
//
// Where a real captured fixture (tests/fixtures/appstore/) isn't precise enough — the
// pagination-ceiling scenario needs exactly 10 successive non-empty pages with known,
// strictly-decreasing timestamps, and live pagination past page 1 proved unreliable to
// reproduce on demand during verification (documented in the completion report: probing
// several high-review-volume apps live on 2026-08-05 showed pages 2-9 frequently returning
// empty even for apps whose page 1 and page 10 had content) — entries are constructed here
// with `buildReviewJson`, using the exact field shape verified against the live endpoint
// (see feed.test.ts's fixtures), not a guessed one.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { UpstreamError } from '../../../lib/errors.js';
import { createNetClient, type Transport } from '../../../lib/net.js';
import { createAppStoreAdapter } from '../../../sources/appstore/adapter.js';
import { MAX_PAGES, buildFeedUrl } from '../../../sources/appstore/feed.js';

const FIXTURES_DIR = new URL('../../fixtures/appstore/', import.meta.url);

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(name, FIXTURES_DIR), 'utf8'));
}

let nextReviewId = 90_000_000_000;

/** One synthetic review entry, shaped exactly like a real one (see feed.test.ts's fixtures). */
function buildReviewJson(fields: { rating: number; updatedIso: string; title?: string }): Record<string, unknown> {
  nextReviewId += 1;
  const id = String(nextReviewId);
  return {
    author: { uri: { label: `https://itunes.apple.com/us/reviews/id${id}` }, name: { label: `tester${id}` }, label: '' },
    updated: { label: fields.updatedIso },
    'im:rating': { label: String(fields.rating) },
    'im:version': { label: '1.0.0' },
    id: { label: id },
    title: { label: fields.title ?? 'Test review' },
    content: { label: `Body of review ${id}`, attributes: { type: 'text' } },
    link: { attributes: { rel: 'related', href: 'https://itunes.apple.com/us/review?id=1&type=Purple%20Software' } },
    'im:voteSum': { label: '0' },
    'im:contentType': { attributes: { term: 'Application', label: 'Application' } },
    'im:voteCount': { label: '0' },
  };
}

function feedEnvelope(entries: readonly unknown[]): unknown {
  return {
    feed: {
      author: { name: { label: 'iTunes Store' }, uri: { label: 'http://www.apple.com/itunes/' } },
      entry: entries,
      updated: { label: '2026-08-05T00:00:00-07:00' },
    },
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

function emptyFeedResponse(): Response {
  return jsonResponse(loadFixture('empty-feed.json'));
}

/** Day `n` before a fixed anchor, most-recent-first as `n` grows — matches the feed's own
 * sortby=mostrecent ordering, so page 1 is always the newest. */
function isoDaysAgo(n: number): string {
  return new Date(Date.UTC(2026, 7, 4, 0, 0, 0) - n * 24 * 60 * 60 * 1000).toISOString();
}

/** Routes a fake transport by exact URL — a wiring bug (a request this test didn't expect)
 * fails loudly rather than hanging or silently returning nothing. */
function makeRoutedTransport(routes: ReadonlyMap<string, () => Response>): Transport {
  return async (url) => {
    const handler = routes.get(url);
    if (handler === undefined) {
      // tests/** is exempt from the construct-built-in-error ban (eslint.config.js TESTS_GLOB
      // override) — this never reaches production code, it is a test-harness wiring bug.
      throw new Error(`makeRoutedTransport: no route registered for ${url}`);
    }
    return handler();
  };
}

function buildTestNetClient(routes: ReadonlyMap<string, () => Response>) {
  // `sleep` is a no-op so a scenario that deliberately exhausts lib/net.ts's retries (the
  // partial-outcome and checkHealth-failure tests below) resolves instantly instead of
  // waiting out real exponential backoff.
  return createNetClient({ transport: makeRoutedTransport(routes), sleep: async () => {} });
}

describe('createAppStoreAdapter', () => {
  it('has source "appstore" and does not touch the network at construction time', () => {
    const adapter = createAppStoreAdapter();
    expect(adapter.source).toBe('appstore');
  });

  describe('criterion 1: fetches reviews across the configured app-ID list x territories', () => {
    it('fans out across every (appId, territory) pair and returns one document per pair', async () => {
      const appIds = ['111', '222'];
      const territories = ['us', 'gb'];
      const routes = new Map<string, () => Response>();
      for (const appId of appIds) {
        for (const territory of territories) {
          routes.set(buildFeedUrl(appId, territory, 1), () =>
            jsonResponse(feedEnvelope([buildReviewJson({ rating: 5, updatedIso: isoDaysAgo(0) })])),
          );
          routes.set(buildFeedUrl(appId, territory, 2), emptyFeedResponse);
        }
      }
      const netClient = buildTestNetClient(routes);
      const adapter = createAppStoreAdapter({ appIds, territories, netClient });

      const result = await adapter.fetchIncremental(undefined);

      expect(result.documents).toHaveLength(4);
      const urls = new Set(result.documents.map((doc) => doc.url));
      expect(urls).toEqual(
        new Set([
          'https://apps.apple.com/us/app/id111?see-all=reviews',
          'https://apps.apple.com/gb/app/id111?see-all=reviews',
          'https://apps.apple.com/us/app/id222?see-all=reviews',
          'https://apps.apple.com/gb/app/id222?see-all=reviews',
        ]),
      );
    });
  });

  describe('criterion 2: rating is preserved on the normalized Document', () => {
    it('preserves every star rating (1-5), as a number, through a full fetchIncremental call', async () => {
      const pair = { appId: '284910350', territory: 'us' };
      const routes = new Map<string, () => Response>();
      routes.set(buildFeedUrl(pair.appId, pair.territory, 1), () => jsonResponse(loadFixture('page1-mixed-ratings.json')));
      routes.set(buildFeedUrl(pair.appId, pair.territory, 2), emptyFeedResponse);
      const netClient = buildTestNetClient(routes);
      const adapter = createAppStoreAdapter({ appIds: [pair.appId], territories: [pair.territory], netClient });

      const result = await adapter.fetchIncremental(undefined);

      const ratings = result.documents.map((doc) => doc.engagement.rating).sort();
      expect(ratings).toEqual([1, 2, 3, 4, 5]);
      for (const doc of result.documents) {
        expect(typeof doc.engagement.rating).toBe('number');
      }
    });
  });

  describe('criterion 3: the 500-review pagination ceiling', () => {
    it('reports outcome "truncated" when a pair still has fresh entries on page MAX_PAGES', async () => {
      const pair = { appId: '333', territory: 'us' };
      const routes = new Map<string, () => Response>();
      for (let page = 1; page <= MAX_PAGES; page++) {
        const entry = buildReviewJson({ rating: 5, updatedIso: isoDaysAgo(page - 1) });
        routes.set(buildFeedUrl(pair.appId, pair.territory, page), () => jsonResponse(feedEnvelope([entry])));
      }
      const netClient = buildTestNetClient(routes);
      const adapter = createAppStoreAdapter({ appIds: [pair.appId], territories: [pair.territory], netClient });

      const result = await adapter.fetchIncremental(undefined);

      expect(result.documents).toHaveLength(MAX_PAGES);
      expect(result.outcome?.kind).toBe('truncated');
      if (result.outcome?.kind === 'truncated') {
        expect(result.outcome.reason).toContain('333 (us)');
        expect(result.outcome.reason.toLowerCase()).toContain('500');
      }
      // Settled rule (fix round 1, Finding 2): fetchIncremental's cursor stays defined even
      // when truncated, since a fan-out call still has a meaningful high-water mark to
      // continue polling from.
      expect(result.cursor).toBeDefined();
    });

    it('does NOT report truncated when a page runs out before the ceiling (ordinary exhaustion)', async () => {
      const pair = { appId: '444', territory: 'us' };
      const routes = new Map<string, () => Response>();
      routes.set(buildFeedUrl(pair.appId, pair.territory, 1), () =>
        jsonResponse(feedEnvelope([buildReviewJson({ rating: 4, updatedIso: isoDaysAgo(0) })])),
      );
      routes.set(buildFeedUrl(pair.appId, pair.territory, 2), emptyFeedResponse);
      const netClient = buildTestNetClient(routes);
      const adapter = createAppStoreAdapter({ appIds: [pair.appId], territories: [pair.territory], netClient });

      const result = await adapter.fetchIncremental(undefined);

      expect(result.documents).toHaveLength(1);
      expect(result.outcome).toBeUndefined();
      expect(result.cursor).toBeDefined();
    });
  });

  describe('incremental cursor behavior', () => {
    it('a second call with the returned cursor only returns reviews newer than the high-water mark', async () => {
      const pair = { appId: '555', territory: 'us' };
      const older = buildReviewJson({ rating: 3, updatedIso: isoDaysAgo(1) });
      const newer = buildReviewJson({ rating: 5, updatedIso: isoDaysAgo(0) });
      const routes = new Map<string, () => Response>();
      routes.set(buildFeedUrl(pair.appId, pair.territory, 1), () => jsonResponse(feedEnvelope([newer, older])));
      routes.set(buildFeedUrl(pair.appId, pair.territory, 2), emptyFeedResponse);
      const netClient = buildTestNetClient(routes);
      const adapter = createAppStoreAdapter({ appIds: [pair.appId], territories: [pair.territory], netClient });

      const first = await adapter.fetchIncremental(undefined);
      expect(first.documents).toHaveLength(2);

      const second = await adapter.fetchIncremental(first.cursor);
      expect(second.documents).toHaveLength(0);
      expect(second.outcome).toBeUndefined();
    });
  });

  describe("resolution 3: partial outcome when one territory fails partway through the fan-out", () => {
    it('keeps documents already collected and attaches the AppError as outcome.error', async () => {
      const good = { appId: '111', territory: 'us' };
      const bad = { appId: '222', territory: 'us' };
      const routes = new Map<string, () => Response>();
      routes.set(buildFeedUrl(good.appId, good.territory, 1), () =>
        jsonResponse(feedEnvelope([buildReviewJson({ rating: 5, updatedIso: isoDaysAgo(0) })])),
      );
      routes.set(buildFeedUrl(good.appId, good.territory, 2), emptyFeedResponse);
      // Exhausts lib/net.ts's retries on every attempt, surfacing as UpstreamError.
      routes.set(buildFeedUrl(bad.appId, bad.territory, 1), () => new Response(null, { status: 500 }));

      const netClient = buildTestNetClient(routes);
      const adapter = createAppStoreAdapter({ appIds: [good.appId, bad.appId], territories: ['us'], netClient });

      const result = await adapter.fetchIncremental(undefined);

      expect(result.documents).toHaveLength(1);
      expect(result.outcome?.kind).toBe('partial');
      if (result.outcome?.kind === 'partial') {
        expect(result.outcome.error).toBeInstanceOf(UpstreamError);
        // Fix round 1, Finding 1: nothing was truncated before `bad` failed, so the field
        // must be absent entirely, not merely falsy — an empty string would also be wrong.
        expect(result.outcome.truncatedReason).toBeUndefined();
      }
    });
  });

  describe('fix round 1, Finding 1: truncatedReason survives an early return from the fan-out loop', () => {
    it('carries an earlier pair\'s ceiling forward when a later pair then fails (fetchIncremental)', async () => {
      const truncated = { appId: 'A1', territory: 'us' };
      const failing = { appId: 'B1', territory: 'us' };
      const routes = new Map<string, () => Response>();
      for (let page = 1; page <= MAX_PAGES; page++) {
        const entry = buildReviewJson({ rating: 5, updatedIso: isoDaysAgo(page - 1) });
        routes.set(buildFeedUrl(truncated.appId, truncated.territory, page), () => jsonResponse(feedEnvelope([entry])));
      }
      // Exhausts lib/net.ts's retries on every attempt, surfacing as UpstreamError — same
      // shape as the plain partial-outcome test above, but `truncated` is walked first
      // (pairs are processed in `appIds x territories` order), so its ceiling is already
      // recorded by the time `failing` throws.
      routes.set(buildFeedUrl(failing.appId, failing.territory, 1), () => new Response(null, { status: 500 }));
      const netClient = buildTestNetClient(routes);
      const adapter = createAppStoreAdapter({
        appIds: [truncated.appId, failing.appId],
        territories: ['us'],
        netClient,
      });

      const result = await adapter.fetchIncremental(undefined);

      expect(result.documents).toHaveLength(MAX_PAGES);
      expect(result.outcome?.kind).toBe('partial');
      if (result.outcome?.kind === 'partial') {
        expect(result.outcome.error).toBeInstanceOf(UpstreamError);
        expect(result.outcome.truncatedReason).toBeDefined();
        expect(result.outcome.truncatedReason).toContain('A1 (us)');
        expect(result.outcome.truncatedReason?.toLowerCase()).toContain('500');
      }
    });

    it('carries an earlier pair\'s ceiling forward when a later pair then fails (fetchBackfill)', async () => {
      const truncated = { appId: 'A2', territory: 'us' };
      const failing = { appId: 'B2', territory: 'us' };
      const routes = new Map<string, () => Response>();
      for (let page = 1; page <= MAX_PAGES; page++) {
        const entry = buildReviewJson({ rating: 5, updatedIso: isoDaysAgo(page - 1) });
        routes.set(buildFeedUrl(truncated.appId, truncated.territory, page), () => jsonResponse(feedEnvelope([entry])));
      }
      routes.set(buildFeedUrl(failing.appId, failing.territory, 1), () => new Response(null, { status: 500 }));
      const netClient = buildTestNetClient(routes);
      const adapter = createAppStoreAdapter({
        appIds: [truncated.appId, failing.appId],
        territories: ['us'],
        netClient,
      });

      const range = { since: new Date('2026-01-01T00:00:00.000Z'), until: new Date('2026-12-31T00:00:00.000Z') };
      const result = await adapter.fetchBackfill(range, undefined);

      expect(result.documents).toHaveLength(MAX_PAGES);
      expect(result.outcome?.kind).toBe('partial');
      if (result.outcome?.kind === 'partial') {
        expect(result.outcome.error).toBeInstanceOf(UpstreamError);
        expect(result.outcome.truncatedReason).toBeDefined();
        expect(result.outcome.truncatedReason).toContain('A2 (us)');
      }
    });

    it('leaves an already-collected pair\'s high-water mark advanced and a failing pair\'s untouched (fetchIncremental)', async () => {
      // Distinct from the "resumed call" fetchBackfill test below: this asserts the *shape*
      // of nextState across the early return itself — a pair processed before the failure
      // must show its new progress, and the failing pair's own prior mark (from an inbound
      // cursor) must be left exactly as it was, not reset to `undefined` or advanced.
      const good = { appId: 'C1', territory: 'us' };
      const bad = { appId: 'D1', territory: 'us' };
      const priorMark = isoDaysAgo(5);
      const initialCursor = JSON.stringify({
        [`${good.appId}:${good.territory}`]: priorMark,
        [`${bad.appId}:${bad.territory}`]: priorMark,
      });
      const routes = new Map<string, () => Response>();
      routes.set(buildFeedUrl(good.appId, good.territory, 1), () =>
        jsonResponse(feedEnvelope([buildReviewJson({ rating: 5, updatedIso: isoDaysAgo(0) })])),
      );
      routes.set(buildFeedUrl(good.appId, good.territory, 2), emptyFeedResponse);
      routes.set(buildFeedUrl(bad.appId, bad.territory, 1), () => new Response(null, { status: 500 }));
      const netClient = buildTestNetClient(routes);
      const adapter = createAppStoreAdapter({ appIds: [good.appId, bad.appId], territories: ['us'], netClient });

      const result = await adapter.fetchIncremental(initialCursor);

      expect(result.documents).toHaveLength(1);
      expect(result.outcome?.kind).toBe('partial');
      expect(result.cursor).toBeDefined();
      const decoded = JSON.parse(result.cursor ?? '{}') as Record<string, string>;
      expect(decoded[`${good.appId}:${good.territory}`]).toBe(isoDaysAgo(0));
      expect(decoded[`${bad.appId}:${bad.territory}`]).toBe(priorMark);
    });
  });

  describe('checkHealth', () => {
    it('reports healthy: true for a 200 response', async () => {
      const pair = { appId: '111', territory: 'us' };
      const routes = new Map<string, () => Response>();
      routes.set(buildFeedUrl(pair.appId, pair.territory, 1), emptyFeedResponse);
      const netClient = buildTestNetClient(routes);
      const adapter = createAppStoreAdapter({ appIds: [pair.appId], territories: [pair.territory], netClient });

      const health = await adapter.checkHealth();
      expect(health.healthy).toBe(true);
    });

    it('reports healthy: false (never throws) when the upstream fails', async () => {
      const pair = { appId: '111', territory: 'us' };
      const routes = new Map<string, () => Response>();
      routes.set(buildFeedUrl(pair.appId, pair.territory, 1), () => new Response(null, { status: 500 }));
      const netClient = buildTestNetClient(routes);
      const adapter = createAppStoreAdapter({ appIds: [pair.appId], territories: [pair.territory], netClient });

      const health = await adapter.checkHealth();
      expect(health.healthy).toBe(false);
      expect(health.detail.length).toBeGreaterThan(0);
    });
  });

  describe('I-03-fix defect 3: identifies itself with a User-Agent', () => {
    it('sends a descriptive User-Agent header on both the review-fetch and checkHealth request paths', async () => {
      // A capturing transport rather than makeRoutedTransport's routes map — the thing under
      // test here is what performRequest hands the transport as `init`, not the response.
      const pair = { appId: '999', territory: 'us' };
      const seenUserAgents: (string | undefined)[] = [];
      const transport: Transport = (url, init) => {
        if (url !== buildFeedUrl(pair.appId, pair.territory, 1)) {
          // tests/** is exempt from the construct-built-in-error ban (eslint.config.js
          // TESTS_GLOB override) — a wiring bug in this test, not production code.
          throw new Error(`unexpected request: ${url}`);
        }
        seenUserAgents.push((init.headers as Record<string, string> | undefined)?.['User-Agent']);
        return Promise.resolve(emptyFeedResponse());
      };
      const netClient = createNetClient({ transport, sleep: async () => {} });
      const adapter = createAppStoreAdapter({ appIds: [pair.appId], territories: [pair.territory], netClient });

      await adapter.fetchIncremental(undefined);
      await adapter.checkHealth();

      expect(seenUserAgents).toHaveLength(2);
      for (const userAgent of seenUserAgents) {
        expect(userAgent).toBeDefined();
        expect(userAgent).toMatch(/^fetch-app-appstore-adapter\//);
      }
    });
  });

  describe('fetchBackfill', () => {
    it('includes only entries within [range.since, range.until], skipping newer ones while still paging for older matches', async () => {
      const pair = { appId: '666', territory: 'us' };
      const tooNew = buildReviewJson({ rating: 5, updatedIso: '2026-08-04T00:00:00.000Z' });
      const inRange = buildReviewJson({ rating: 3, updatedIso: '2026-08-02T00:00:00.000Z' });
      const routes = new Map<string, () => Response>();
      routes.set(buildFeedUrl(pair.appId, pair.territory, 1), () => jsonResponse(feedEnvelope([tooNew, inRange])));
      routes.set(buildFeedUrl(pair.appId, pair.territory, 2), emptyFeedResponse);
      const netClient = buildTestNetClient(routes);
      const adapter = createAppStoreAdapter({ appIds: [pair.appId], territories: [pair.territory], netClient });

      const range = { since: new Date('2026-08-01T00:00:00.000Z'), until: new Date('2026-08-03T00:00:00.000Z') };
      const result = await adapter.fetchBackfill(range, undefined);

      expect(result.documents).toHaveLength(1);
      expect(result.documents[0]?.engagement.rating).toBe(3);
      expect(result.cursor).toBeUndefined();
      expect(result.outcome).toBeUndefined();
    });

    it('stops paging once it finds an entry older than range.since, without marking truncated', async () => {
      const pair = { appId: '777', territory: 'us' };
      const inRange = buildReviewJson({ rating: 4, updatedIso: '2026-08-02T00:00:00.000Z' });
      const tooOld = buildReviewJson({ rating: 2, updatedIso: '2026-07-01T00:00:00.000Z' });
      const routes = new Map<string, () => Response>();
      // Both entries on page 1 — the walk must stop as soon as it sees `tooOld`, and must
      // never request page 2 (no route registered for it; an unexpected request throws).
      routes.set(buildFeedUrl(pair.appId, pair.territory, 1), () => jsonResponse(feedEnvelope([inRange, tooOld])));
      const netClient = buildTestNetClient(routes);
      const adapter = createAppStoreAdapter({ appIds: [pair.appId], territories: [pair.territory], netClient });

      const range = { since: new Date('2026-08-01T00:00:00.000Z'), until: new Date('2026-08-03T00:00:00.000Z') };
      const result = await adapter.fetchBackfill(range, undefined);

      expect(result.documents).toHaveLength(1);
      expect(result.outcome).toBeUndefined();
    });

    it('reports truncated with cursor: undefined when the ceiling is hit inside the requested range', async () => {
      const pair = { appId: '888', territory: 'us' };
      const routes = new Map<string, () => Response>();
      for (let page = 1; page <= MAX_PAGES; page++) {
        const entry = buildReviewJson({ rating: 5, updatedIso: isoDaysAgo(page - 1) });
        routes.set(buildFeedUrl(pair.appId, pair.territory, page), () => jsonResponse(feedEnvelope([entry])));
      }
      const netClient = buildTestNetClient(routes);
      const adapter = createAppStoreAdapter({ appIds: [pair.appId], territories: [pair.territory], netClient });

      // A range wide enough to cover all 10 synthetic days.
      const range = { since: new Date('2026-01-01T00:00:00.000Z'), until: new Date('2026-12-31T00:00:00.000Z') };
      const result = await adapter.fetchBackfill(range, undefined);

      expect(result.documents).toHaveLength(MAX_PAGES);
      expect(result.outcome?.kind).toBe('truncated');
      // FetchPage's documented "cannot page any further" applies literally here (unlike
      // fetchIncremental's ceiling case above): a backfill call fully processes `range` in
      // one shot, so there is no follow-up call left to make for this same range.
      expect(result.cursor).toBeUndefined();
    });

    it('a resumed call (using the cursor from a partial outcome) does not re-emit an already-finished pair\'s documents', async () => {
      const good = { appId: '111', territory: 'us' };
      const bad = { appId: '222', territory: 'us' };
      const goodEntry = buildReviewJson({ rating: 5, updatedIso: '2026-08-02T00:00:00.000Z' });
      const badEntry = buildReviewJson({ rating: 4, updatedIso: '2026-08-02T00:00:00.000Z' });
      const range = { since: new Date('2026-08-01T00:00:00.000Z'), until: new Date('2026-08-03T00:00:00.000Z') };

      const firstRoutes = new Map<string, () => Response>();
      firstRoutes.set(buildFeedUrl(good.appId, good.territory, 1), () => jsonResponse(feedEnvelope([goodEntry])));
      firstRoutes.set(buildFeedUrl(good.appId, good.territory, 2), emptyFeedResponse);
      firstRoutes.set(buildFeedUrl(bad.appId, bad.territory, 1), () => new Response(null, { status: 500 }));
      const firstNetClient = buildTestNetClient(firstRoutes);
      const adapter = createAppStoreAdapter({
        appIds: [good.appId, bad.appId],
        territories: ['us'],
        netClient: firstNetClient,
      });

      const first = await adapter.fetchBackfill(range, undefined);
      expect(first.documents).toHaveLength(1);
      expect(first.outcome?.kind).toBe('partial');
      if (first.outcome?.kind === 'partial') {
        // Fix round 1, Finding 1: `good` never hit the ceiling, so no truncation to carry.
        expect(first.outcome.truncatedReason).toBeUndefined();
      }
      expect(first.cursor).toBeDefined();

      // Retry: both pairs now succeed. `good` would be walked again (fetchBackfill always
      // re-walks every pair) but its one review is already reflected in the resume cursor,
      // so it must not appear a second time in `second.documents`.
      const secondRoutes = new Map<string, () => Response>();
      secondRoutes.set(buildFeedUrl(good.appId, good.territory, 1), () => jsonResponse(feedEnvelope([goodEntry])));
      secondRoutes.set(buildFeedUrl(good.appId, good.territory, 2), emptyFeedResponse);
      secondRoutes.set(buildFeedUrl(bad.appId, bad.territory, 1), () => jsonResponse(feedEnvelope([badEntry])));
      secondRoutes.set(buildFeedUrl(bad.appId, bad.territory, 2), emptyFeedResponse);
      const secondNetClient = buildTestNetClient(secondRoutes);
      const adapterRetry = createAppStoreAdapter({
        appIds: [good.appId, bad.appId],
        territories: ['us'],
        netClient: secondNetClient,
      });

      const second = await adapterRetry.fetchBackfill(range, first.cursor);
      expect(second.documents).toHaveLength(1);
      expect(second.documents[0]?.engagement.rating).toBe(4);
      expect(second.outcome).toBeUndefined();
      expect(second.cursor).toBeUndefined();
    });
  });
});
