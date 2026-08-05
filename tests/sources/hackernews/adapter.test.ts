// Integration tests against recorded fixtures (SPEC I-02 criterion 4), never the live
// network — `tests/sources/hackernews/**` is the one place outside sources/registry.ts the
// adapter-deep-import ban is lifted (wave3 shared context resolution 4) specifically so this
// file can import the adapter module directly.
//
// The fake Algolia transport below does not just replay a canned response: it actually
// filters a fixed set of hits by the `numericFilters` the adapter sent, the same way the
// real API would. That is deliberate — criterion 1's real content is proving a *second*
// call against the *same* underlying data returns nothing new, and a handler that filters
// for real is what makes that a genuine proof of the adapter's own boundary math rather than
// a hand-scripted "second response happens to be empty".
import { describe, expect, it } from 'vitest';
import { createNetClient, type Transport } from '../../../lib/net.js';
import { NetworkError } from '../../../lib/errors.js';
import { createHackerNewsAdapter } from '../../../sources/hackernews/adapter.js';
import firebaseStory from '../../fixtures/hackernews/firebase-story.json' with { type: 'json' };
import firebaseComment from '../../fixtures/hackernews/firebase-comment.json' with { type: 'json' };
import firebaseDeleted from '../../fixtures/hackernews/firebase-deleted.json' with { type: 'json' };
import firebaseDeadComment from '../../fixtures/hackernews/firebase-dead-comment.json' with { type: 'json' };
import firebaseDeadStory from '../../fixtures/hackernews/firebase-dead-story.json' with { type: 'json' };
import realAlgoliaResponse from '../../fixtures/hackernews/algolia-search-response.json' with { type: 'json' };

interface FixtureHit {
  readonly objectID: string;
  readonly created_at_i: number;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

// Parses exactly the two shapes adapter.ts ever sends (mirrors its own `lowerOperator ?
// '>=' : '>'` construction) — a bespoke parser rather than a general one is fine since this
// is a test double asserting against a producer this same file controls.
function parseNumericFilters(numericFilters: string): { min: number; minInclusive: boolean; max: number } {
  const [lower, upper] = numericFilters.split(',');
  const lowerMatch = /^created_at_i(>=|>)(\d+)$/.exec(lower ?? '');
  const upperMatch = /^created_at_i<=(\d+)$/.exec(upper ?? '');
  if (lowerMatch === null || upperMatch === null) {
    throw new Error(`test fixture cannot parse numericFilters: ${numericFilters}`);
  }
  return { minInclusive: lowerMatch[1] === '>=', min: Number(lowerMatch[2]), max: Number(upperMatch[1]) };
}

interface HackerNewsTransportConfig {
  /** The full, fixed dataset every Algolia call filters against — never mutated between calls. */
  readonly hits: readonly FixtureHit[];
  /** id -> Firebase item body. `undefined` for an id present in `hits` but absent here means "Firebase returns null" — the missing-item path, not a test wiring gap. */
  readonly firebaseItems?: Readonly<Record<string, unknown>>;
  readonly maxItem?: number;
  /** Thrown on the Nth Algolia or Firebase call (1-indexed) instead of responding, for partial-outcome and propagation tests. */
  readonly failOnCall?: number;
}

function makeHackerNewsTransport(config: HackerNewsTransportConfig): {
  transport: Transport;
  calls: string[];
} {
  const calls: string[] = [];
  const transport: Transport = async (url) => {
    calls.push(url);
    if (config.failOnCall === calls.length) {
      throw new NetworkError('simulated transport failure', { context: { url } });
    }
    const parsed = new URL(url);
    if (parsed.hostname === 'hn.algolia.com') {
      const params = parsed.searchParams;
      const { min, minInclusive, max } = parseNumericFilters(params.get('numericFilters') ?? '');
      const hitsPerPage = Number(params.get('hitsPerPage') ?? '1000');
      const page = Number(params.get('page') ?? '0');
      const matched = config.hits
        .filter((h) => (minInclusive ? h.created_at_i >= min : h.created_at_i > min) && h.created_at_i <= max)
        // Real Algolia sorts search_by_date newest-first (verified live) — the fake must
        // match, since collectWindow's page-selection logic depends on that ordering.
        .sort((a, b) => b.created_at_i - a.created_at_i);
      const nbPages = Math.max(1, Math.ceil(matched.length / hitsPerPage));
      const pageHits = matched.slice(page * hitsPerPage, (page + 1) * hitsPerPage);
      return jsonResponse({ hits: pageHits, nbPages, page, hitsPerPage, nbHits: matched.length });
    }
    if (parsed.hostname === 'hacker-news.firebaseio.com') {
      if (parsed.pathname === '/v0/maxitem.json') {
        return jsonResponse(config.maxItem ?? 0);
      }
      const match = /^\/v0\/item\/(.+)\.json$/.exec(parsed.pathname);
      if (match?.[1] !== undefined) {
        const body = config.firebaseItems?.[match[1]];
        return jsonResponse(body === undefined ? null : body);
      }
    }
    throw new Error(`unexpected URL requested in test: ${url}`);
  };
  return { transport, calls };
}

// Every scenario builds its adapter with small, deterministic knobs instead of the
// production defaults (24h lookback, 1000 hitsPerPage) so tests run against a handful of
// fixture items rather than needing to simulate a realistic-sized index.
function buildAdapter(
  config: HackerNewsTransportConfig,
  overrides: {
    nowMs?: number;
    hitsPerPage?: number;
    maxPagesPerQuery?: number;
    indexLagBufferSeconds?: number;
    initialLookbackSeconds?: number;
    queries?: readonly string[];
  } = {},
) {
  const { transport, calls } = makeHackerNewsTransport(config);
  // maxAttempts: 1 so a simulated `failOnCall` failure surfaces as a single thrown
  // NetworkError instead of lib/net.ts silently retrying it into a success on the next
  // attempt — retry behaviour itself is lib/net.ts's own test suite's concern, not this
  // adapter's, and letting it run here would make `failOnCall`'s call-count bookkeeping
  // depend on the default backoff schedule instead of being deterministic.
  const netClient = createNetClient({
    transport,
    sleep: async () => undefined,
    now: () => overrides.nowMs ?? 0,
    retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
  });
  const adapter = createHackerNewsAdapter({
    netClient,
    now: () => overrides.nowMs ?? 0,
    hitsPerPage: overrides.hitsPerPage ?? 1000,
    maxPagesPerQuery: overrides.maxPagesPerQuery ?? 5,
    indexLagBufferSeconds: overrides.indexLagBufferSeconds ?? 10,
    initialLookbackSeconds: overrides.initialLookbackSeconds ?? 3600,
    queries: overrides.queries ?? [''],
  });
  return { adapter, calls };
}

const NOW_MS = Date.UTC(2026, 0, 1, 0, 0, 0);
const NOW_SEC = NOW_MS / 1000;

describe('createHackerNewsAdapter', () => {
  describe('fetchIncremental: discovery + hydration + mapping', () => {
    it('maps a story and a comment, in author/title/body/engagement/url/raw, from Firebase hydration', async () => {
      const sinceSec = NOW_SEC - 3600;
      const hits: FixtureHit[] = [
        { objectID: '100', created_at_i: sinceSec + 100 },
        { objectID: '82', created_at_i: sinceSec + 200 },
      ];
      const { adapter } = buildAdapter(
        { hits, firebaseItems: { '100': firebaseStory, '82': firebaseComment } },
        { nowMs: NOW_MS },
      );

      const page = await adapter.fetchIncremental(undefined);

      expect(page.documents).toHaveLength(2);
      const story = page.documents.find((d) => d.sourceId === '100');
      const comment = page.documents.find((d) => d.sourceId === '82');

      expect(story).toMatchObject({
        source: 'hackernews',
        sourceId: '100',
        url: 'https://news.ycombinator.com/item?id=100',
        authorHandle: 'pc',
        title: 'SpikeSource, CA-based startup, becomes Ubuntu commercial support provider for US',
        body: '',
        engagement: { points: 6, commentCount: 0 },
      });
      expect(story?.createdAt).toEqual(new Date(1171910288 * 1000));
      expect(story?.raw).toMatchObject({ id: 100, score: 6 });

      expect(comment).toMatchObject({
        source: 'hackernews',
        sourceId: '82',
        url: 'https://news.ycombinator.com/item?id=82',
        authorHandle: 'solfox',
        title: null,
        body: 'dude, shoutfit!',
        engagement: { replyCount: 0 },
      });
      expect(comment?.raw).toMatchObject({ id: 82, text: 'dude, shoutfit!' });
    });

    it('parses a real captured Algolia response without choking on fields it does not use', async () => {
      // realAlgoliaResponse is a genuine, unmodified capture (tests/fixtures/hackernews) —
      // proving the zod schema tolerates every extra field Algolia actually sends
      // (`_highlightResult`, `exhaustive`, ...) rather than assuming a hand-trimmed shape.
      const hitsFromRealResponse = (realAlgoliaResponse as { hits: FixtureHit[] }).hits;
      expect(hitsFromRealResponse.length).toBeGreaterThan(0);
      const sinceSec = NOW_SEC - 3600;
      const hits: FixtureHit[] = hitsFromRealResponse.map((h, i) => ({
        objectID: h.objectID,
        created_at_i: sinceSec + 100 + i,
      }));
      const { adapter } = buildAdapter(
        { hits, firebaseItems: Object.fromEntries(hits.map((h) => [h.objectID, firebaseComment])) },
        { nowMs: NOW_MS },
      );

      const page = await adapter.fetchIncremental(undefined);

      expect(page.documents).toHaveLength(hits.length);
    });
  });

  describe('deleted and dead items — three genuinely different "no document" paths (brief resolution 3)', () => {
    it('skips a Firebase 200-with-null-body item without throwing or aborting the page', async () => {
      const sinceSec = NOW_SEC - 3600;
      const hits: FixtureHit[] = [
        { objectID: '100', created_at_i: sinceSec + 100 }, // a real document, alongside the null one
        { objectID: 'ghost', created_at_i: sinceSec + 200 }, // absent from firebaseItems -> transport returns literal null
      ];
      const { adapter } = buildAdapter({ hits, firebaseItems: { '100': firebaseStory } }, { nowMs: NOW_MS });

      const page = await adapter.fetchIncremental(undefined);

      expect(page.documents).toHaveLength(1);
      expect(page.documents[0]?.sourceId).toBe('100');
    });

    it('skips a deleted:true item without throwing or aborting the page', async () => {
      const sinceSec = NOW_SEC - 3600;
      const hits: FixtureHit[] = [
        { objectID: '100', created_at_i: sinceSec + 100 },
        { objectID: '464647', created_at_i: sinceSec + 200 },
      ];
      const { adapter } = buildAdapter(
        { hits, firebaseItems: { '100': firebaseStory, '464647': firebaseDeleted } },
        { nowMs: NOW_MS },
      );

      const page = await adapter.fetchIncremental(undefined);

      expect(page.documents).toHaveLength(1);
      expect(page.documents[0]?.sourceId).toBe('100');
    });

    it('skips a dead:true comment without throwing or aborting the page', async () => {
      const sinceSec = NOW_SEC - 3600;
      const hits: FixtureHit[] = [
        { objectID: '100', created_at_i: sinceSec + 100 },
        { objectID: '154', created_at_i: sinceSec + 200 },
      ];
      const { adapter } = buildAdapter(
        { hits, firebaseItems: { '100': firebaseStory, '154': firebaseDeadComment } },
        { nowMs: NOW_MS },
      );

      const page = await adapter.fetchIncremental(undefined);

      expect(page.documents).toHaveLength(1);
      expect(page.documents[0]?.sourceId).toBe('100');
    });

    it('skips a dead:true story without throwing or aborting the page', async () => {
      const sinceSec = NOW_SEC - 3600;
      const hits: FixtureHit[] = [
        { objectID: '100', created_at_i: sinceSec + 100 },
        { objectID: '179', created_at_i: sinceSec + 200 },
      ];
      const { adapter } = buildAdapter(
        { hits, firebaseItems: { '100': firebaseStory, '179': firebaseDeadStory } },
        { nowMs: NOW_MS },
      );

      const page = await adapter.fetchIncremental(undefined);

      expect(page.documents).toHaveLength(1);
      expect(page.documents[0]?.sourceId).toBe('100');
    });

    it('skips an item whose type is neither story nor comment (defensive: Algolia tags should already exclude these)', async () => {
      const sinceSec = NOW_SEC - 3600;
      const hits: FixtureHit[] = [{ objectID: 'job1', created_at_i: sinceSec + 100 }];
      const { adapter } = buildAdapter(
        { hits, firebaseItems: { job1: { id: 1, type: 'job', time: sinceSec + 100, title: 'We are hiring' } } },
        { nowMs: NOW_MS },
      );

      const page = await adapter.fetchIncremental(undefined);

      expect(page.documents).toHaveLength(0);
    });

    it('skips an item with an unexpected/malformed shape instead of throwing', async () => {
      const sinceSec = NOW_SEC - 3600;
      const hits: FixtureHit[] = [{ objectID: 'weird', created_at_i: sinceSec + 100 }];
      const { adapter } = buildAdapter(
        { hits, firebaseItems: { weird: { notAnItem: true } } },
        { nowMs: NOW_MS },
      );

      await expect(adapter.fetchIncremental(undefined)).resolves.toMatchObject({ documents: [] });
    });
  });

  describe('criterion 1: cursor-based incremental runs that do not re-fetch on a second consecutive run', () => {
    it('a second consecutive run with an unchanged clock returns zero documents without even querying', async () => {
      const sinceSec = NOW_SEC - 3600;
      const hits: FixtureHit[] = [{ objectID: '100', created_at_i: sinceSec + 100 }];
      const { adapter, calls } = buildAdapter(
        { hits, firebaseItems: { '100': firebaseStory } },
        { nowMs: NOW_MS },
      );

      const first = await adapter.fetchIncremental(undefined);
      expect(first.documents).toHaveLength(1);
      expect(first.cursor).toBeDefined();

      const callsAfterFirstRun = calls.length;
      const second = await adapter.fetchIncremental(first.cursor);

      expect(second.documents).toEqual([]);
      // The index-lag buffer keeps `until` pinned to the same value while the clock hasn't
      // moved, so `until <= since` on the second call — the adapter must recognise that
      // without a network round trip, not by querying and getting an empty page back.
      expect(calls.length).toBe(callsAfterFirstRun);
    });

    it('a second run after real time passes, but with no new fixture data, still returns zero documents', async () => {
      const sinceSec = NOW_SEC - 3600;
      const hits: FixtureHit[] = [{ objectID: '100', created_at_i: sinceSec + 100 }];
      let nowMs = NOW_MS;
      const { transport } = makeHackerNewsTransport({ hits, firebaseItems: { '100': firebaseStory } });
      const netClient = createNetClient({ transport, sleep: async () => undefined, now: () => nowMs });
      const adapter = createHackerNewsAdapter({
        netClient,
        now: () => nowMs,
        maxPagesPerQuery: 5,
        indexLagBufferSeconds: 10,
        initialLookbackSeconds: 3600,
        queries: [''],
      });

      const first = await adapter.fetchIncremental(undefined);
      expect(first.documents).toHaveLength(1);

      nowMs += 5000 * 1000; // real time passes; the fixture dataset itself never changes
      const second = await adapter.fetchIncremental(first.cursor);

      expect(second.documents).toEqual([]);
      expect(second.cursor).toBeDefined();
      expect(Number(second.cursor)).toBeGreaterThan(Number(first.cursor));
    });

    it('chooses a strictly-greater lower bound, so an item sharing the cursor timestamp is not re-fetched', async () => {
      const sinceSec = NOW_SEC - 3600;
      const boundaryHit: FixtureHit = { objectID: '100', created_at_i: sinceSec + 100 };
      const { adapter } = buildAdapter(
        { hits: [boundaryHit], firebaseItems: { '100': firebaseStory } },
        { nowMs: NOW_MS, indexLagBufferSeconds: 0 },
      );

      const first = await adapter.fetchIncremental(undefined);
      expect(first.cursor).toBeDefined();
      const cursorSec = Number(first.cursor);

      // Assert the literal request the adapter sent for the *next* call would use `>`, not
      // `>=` — the boundary decision itself (composer resolution 2), not just its effect.
      const laterMs = NOW_MS + 20_000_000; // real time passing between runs, in milliseconds
      const laterSec = laterMs / 1000;
      const { transport: transport2, calls: calls2 } = makeHackerNewsTransport({
        hits: [{ objectID: '100', created_at_i: cursorSec }], // an item landing exactly on the boundary
        firebaseItems: { '100': firebaseStory },
      });
      const netClient2 = createNetClient({ transport: transport2, sleep: async () => undefined, now: () => laterMs });
      const adapter2 = createHackerNewsAdapter({
        netClient: netClient2,
        now: () => laterMs,
        indexLagBufferSeconds: 0,
        queries: [''],
      });

      const second = await adapter2.fetchIncremental(first.cursor);

      const algoliaCall = calls2.find((u) => u.includes('hn.algolia.com'));
      expect(algoliaCall).toBeDefined();
      const numericFilters = new URL(algoliaCall ?? '').searchParams.get('numericFilters');
      expect(numericFilters).toBe(`created_at_i>${cursorSec},created_at_i<=${laterSec}`);
      // Behavioural proof, not just the request shape: the item sitting exactly on the
      // previous cursor is excluded from this call's results.
      expect(second.documents).toEqual([]);
    });
  });

  describe('per-call page cap: capped queries still return a correct, resumable cursor', () => {
    it('never permanently skips an item when a window has more pages than maxPagesPerQuery', async () => {
      const sinceSec = NOW_SEC - 3600;
      const total = 9;
      const hits: FixtureHit[] = Array.from({ length: total }, (_, i) => ({
        objectID: String(100 + i),
        created_at_i: sinceSec + 10 * (i + 1),
      }));
      const firebaseItems = Object.fromEntries(hits.map((h) => [h.objectID, { ...firebaseStory, id: Number(h.objectID) }]));
      // hitsPerPage 2 and maxPagesPerQuery 2 caps each call at 4 items even though 9 exist.
      const { adapter } = buildAdapter(
        { hits, firebaseItems },
        { nowMs: NOW_MS, hitsPerPage: 2, maxPagesPerQuery: 2 },
      );

      // Fix round 1 (never claim a boundary at a tied timestamp) means a capped call never
      // reports its own single highest fetched item as confirmed, since that item might have
      // an unfetched twin sharing its exact second. That item is therefore legitimately
      // re-fetched on the call that follows — a bounded, one-time re-fetch per capped call,
      // not the unlimited duplication a real regression would cause. This test asserts the
      // property that actually matters (every item eventually seen, none permanently lost)
      // and bounds the acceptable re-fetch cost, rather than requiring zero duplicates ever.
      const seenCounts = new Map<string, number>();
      let cursor: string | undefined;
      let sawCappedPage = false;
      for (let i = 0; i < 10; i++) {
        const page = await adapter.fetchIncremental(cursor);
        if (page.documents.length > 0 && page.documents.length < total) {
          sawCappedPage = true;
        }
        for (const doc of page.documents) {
          seenCounts.set(doc.sourceId, (seenCounts.get(doc.sourceId) ?? 0) + 1);
        }
        if (page.cursor === undefined) {
          break;
        }
        cursor = page.cursor;
      }

      expect(sawCappedPage).toBe(true); // the cap was actually exercised, not a no-op
      expect(seenCounts.size).toBe(total); // nothing was ever permanently skipped
      for (const [, count] of seenCounts) {
        expect(count).toBeLessThanOrEqual(2); // bounded re-fetch, not unbounded duplication
      }
    });
  });

  describe('fix round 1: a tied created_at_i is never claimed as a fully-covered boundary', () => {
    it('never permanently drops an item that ties the boundary timestamp of a capped page', async () => {
      const sinceSec = NOW_SEC - 3600;
      // Firebase's own `id` field, not the Algolia objectID, is what toDocument uses for
      // sourceId — objectIDs below are canonical decimal strings so `Number(objectID)` round
      // trips exactly, keeping the two identifiable by the same string throughout the test.
      const EXCLUDED_TOP = '301'; // sinceSec + 100 — beyond the cap, distinct timestamp
      const TIED_EXCLUDED = '302'; // sinceSec + 90 — beyond the cap, ties TIED_FETCHED
      const TIED_FETCHED = '303'; // sinceSec + 90 — same second as TIED_EXCLUDED, but fetched
      // Six items, newest-first by created_at_i. TIED_EXCLUDED and TIED_FETCHED share the
      // exact same second, straddling the fetch/exclude boundary: TIED_EXCLUDED sits in the
      // page the cap skips this call, TIED_FETCHED sits in the page that IS fetched. This is
      // the reproduction the review finding described — the pre-fix code claimed the
      // boundary at that shared second, which under fetchIncremental's strictly-greater
      // lower bound (composer resolution 2) would exclude TIED_EXCLUDED forever. The
      // remaining three items pad the fetched pages with distinct, lower timestamps so a
      // genuine second-highest-distinct value exists to retreat to.
      const hits: FixtureHit[] = [
        { objectID: EXCLUDED_TOP, created_at_i: sinceSec + 100 },
        { objectID: TIED_EXCLUDED, created_at_i: sinceSec + 90 },
        { objectID: TIED_FETCHED, created_at_i: sinceSec + 90 },
        { objectID: '304', created_at_i: sinceSec + 80 },
        { objectID: '305', created_at_i: sinceSec + 70 },
        { objectID: '306', created_at_i: sinceSec + 60 },
      ];
      const firebaseItems = Object.fromEntries(hits.map((h) => [h.objectID, { ...firebaseStory, id: Number(h.objectID) }]));
      // hitsPerPage 2 + maxPagesPerQuery 2 -> 3 pages total; the cap fetches only the two
      // pages closest to sinceSec (page 1 = [TIED_FETCHED, '304'], page 2 = ['305', '306']).
      // Page 0 = [EXCLUDED_TOP, TIED_EXCLUDED] is not walked this call.
      const { adapter } = buildAdapter(
        { hits, firebaseItems },
        { nowMs: NOW_MS, hitsPerPage: 2, maxPagesPerQuery: 2 },
      );

      const first = await adapter.fetchIncremental(undefined);

      const firstIds = new Set(first.documents.map((d) => d.sourceId));
      expect(firstIds.has(TIED_FETCHED)).toBe(true);
      expect(firstIds.has(TIED_EXCLUDED)).toBe(false); // beyond this call's page cap
      // The claimed boundary is the second-highest *distinct* value fetched (sinceSec + 80),
      // never the tied maximum (sinceSec + 90) — asserted exactly, not just as an inequality,
      // since "less than 90" alone wouldn't distinguish the fix from an unrelated regression.
      expect(first.cursor).toBe(String(sinceSec + 80));

      const second = await adapter.fetchIncremental(first.cursor);
      const secondIds = new Set(second.documents.map((d) => d.sourceId));
      // The whole point: a later call still reaches the item that tied the boundary and was
      // left unfetched. Pre-fix, this assertion fails across every subsequent call forever.
      expect(secondIds.has(TIED_EXCLUDED)).toBe(true);
    });

    it('claims no progress when every item a capped query fetched ties one exact second', async () => {
      const sinceSec = NOW_SEC - 3600;
      const tiedSec = sinceSec + 50;
      // All six items share one exact created_at_i — the degenerate case where no distinct
      // value below the tied maximum exists to safely retreat to (collectWindow's doc
      // comment calls this "unreachable... in practice" at realistic page caps, but the code
      // must still degrade safely rather than claim an unsafe boundary if it ever occurs).
      // Distinct, canonical-decimal objectIDs (rather than e.g. `tied-0`) so sourceId stays
      // meaningfully distinguishable across items even though every timestamp is identical.
      const hits: FixtureHit[] = Array.from({ length: 6 }, (_, i) => ({
        objectID: String(401 + i),
        created_at_i: tiedSec,
      }));
      const firebaseItems = Object.fromEntries(hits.map((h) => [h.objectID, { ...firebaseStory, id: Number(h.objectID) }]));
      const { adapter } = buildAdapter(
        { hits, firebaseItems },
        { nowMs: NOW_MS, hitsPerPage: 2, maxPagesPerQuery: 1 },
      );

      const first = await adapter.fetchIncremental(undefined);

      expect(first.documents.length).toBeGreaterThan(0); // this call still salvages what it fetched
      expect(first.documents.length).toBeLessThan(hits.length); // but did not walk every page
      // No distinct value below the tie exists, so the call cannot honestly claim any
      // progress: the reported boundary equals the same sinceSec the call started from, not
      // the tied timestamp — "no progress" rather than "unsafe progress".
      expect(first.cursor).toBe(String(sinceSec));

      const second = await adapter.fetchIncremental(first.cursor);
      const secondIds = new Set(second.documents.map((d) => d.sourceId));
      const firstIds = new Set(first.documents.map((d) => d.sourceId));
      // Replaying the identical, unadvanced boundary re-covers the same window deterministically
      // rather than skipping forward past the still-unclaimed tied timestamp.
      expect(secondIds).toEqual(firstIds);
    });
  });

  describe('FetchPageOutcome "partial": a fan-out failure salvages already-hydrated documents', () => {
    it('returns already-hydrated documents plus outcome.kind "partial" when hydration fails partway', async () => {
      const sinceSec = NOW_SEC - 3600;
      const hits: FixtureHit[] = [
        { objectID: '100', created_at_i: sinceSec + 100 },
        { objectID: '82', created_at_i: sinceSec + 200 },
      ];
      // Call 1 = Algolia search (succeeds), call 2 = hydrate '100' (succeeds, since Algolia
      // sorts newest-first and '82' is younger... order isn't guaranteed across ids sharing
      // no natural order here, so just fail on call 3, whichever item that lands on.
      const { adapter } = buildAdapter(
        { hits, firebaseItems: { '100': firebaseStory, '82': firebaseComment }, failOnCall: 3 },
        { nowMs: NOW_MS },
      );

      const page = await adapter.fetchIncremental(undefined);

      expect(page.documents).toHaveLength(1); // the one hydration that completed before the failure
      expect(page.cursor).toBeUndefined();
      expect(page.outcome?.kind).toBe('partial');
      if (page.outcome?.kind === 'partial') {
        expect(page.outcome.error).toBeInstanceOf(NetworkError);
      }
    });

    it('propagates the error uncaught when nothing was salvageable yet (the default path)', async () => {
      const sinceSec = NOW_SEC - 3600;
      const hits: FixtureHit[] = [{ objectID: '100', created_at_i: sinceSec + 100 }];
      const { adapter } = buildAdapter(
        { hits, firebaseItems: { '100': firebaseStory }, failOnCall: 1 }, // fails on the Algolia search itself
        { nowMs: NOW_MS },
      );

      await expect(adapter.fetchIncremental(undefined)).rejects.toThrow(NetworkError);
    });
  });

  describe('fetchBackfill', () => {
    it('fetches everything in an inclusive range and reports exhaustion with cursor undefined', async () => {
      const rangeSince = new Date((NOW_SEC - 1000) * 1000);
      const rangeUntil = new Date((NOW_SEC - 500) * 1000);
      const hits: FixtureHit[] = [
        { objectID: '100', created_at_i: Math.floor(rangeSince.getTime() / 1000) }, // exactly on the inclusive lower bound
        { objectID: '82', created_at_i: Math.floor(rangeUntil.getTime() / 1000) }, // exactly on the inclusive upper bound
      ];
      const { adapter } = buildAdapter(
        { hits, firebaseItems: { '100': firebaseStory, '82': firebaseComment } },
        { nowMs: NOW_MS },
      );

      const page = await adapter.fetchBackfill({ since: rangeSince, until: rangeUntil }, undefined);

      expect(page.documents).toHaveLength(2); // both boundary-inclusive items captured
      expect(page.cursor).toBeUndefined();
    });

    it('resumes correctly and never permanently skips an item across a capped range', async () => {
      const rangeSince = new Date((NOW_SEC - 1000) * 1000);
      const rangeUntil = new Date((NOW_SEC - 500) * 1000);
      const sinceSec = Math.floor(rangeSince.getTime() / 1000);
      const untilSec = Math.floor(rangeUntil.getTime() / 1000);
      const total = 6;
      const hits: FixtureHit[] = Array.from({ length: total }, (_, i) => ({
        objectID: String(200 + i),
        created_at_i: sinceSec + Math.floor(((untilSec - sinceSec) * (i + 1)) / (total + 1)),
      }));
      const firebaseItems = Object.fromEntries(hits.map((h) => [h.objectID, { ...firebaseComment, id: Number(h.objectID) }]));
      // maxPagesPerQuery 2, not 1: with a page cap of exactly one page, a capped call's
      // single fetched page can itself hold just one item as the range's tail thins out,
      // leaving zero distinct values fetched that call to retreat to — collectWindow then
      // (correctly, per its own safety rule) claims no progress at all, which can repeat
      // every call thereafter since nothing about a deterministic fixture ever changes. That
      // is a real liveness edge, distinct from the tied-timestamp bug this round fixes, and
      // is reported separately rather than fixed here (see the fix-round report). Two pages
      // per call keeps this test's fetched set large enough to always contain a genuine
      // second distinct value, so it exercises capping without tripping over that edge.
      const { adapter } = buildAdapter(
        { hits, firebaseItems },
        { nowMs: NOW_MS, hitsPerPage: 2, maxPagesPerQuery: 2 },
      );

      // Fix round 1 means a capped call never claims its own single highest fetched item as
      // confirmed (it might have an unfetched twin sharing its exact second), so that item is
      // legitimately re-fetched once on the call that follows — a bounded, documented cost.
      // What must still hold is completeness (nothing permanently lost) and a bound on the
      // re-fetch count, not "zero duplicates ever".
      const seenCounts = new Map<string, number>();
      let cursor: string | undefined;
      for (let i = 0; i < 10; i++) {
        const page = await adapter.fetchBackfill({ since: rangeSince, until: rangeUntil }, cursor);
        for (const doc of page.documents) {
          seenCounts.set(doc.sourceId, (seenCounts.get(doc.sourceId) ?? 0) + 1);
        }
        if (page.cursor === undefined) {
          break;
        }
        cursor = page.cursor;
      }

      expect(seenCounts.size).toBe(total);
      for (const [, count] of seenCounts) {
        expect(count).toBeLessThanOrEqual(2);
      }
    });

    it('returns cursor undefined immediately when the resumption cursor has already reached the range end', async () => {
      const rangeSince = new Date((NOW_SEC - 1000) * 1000);
      const rangeUntil = new Date((NOW_SEC - 500) * 1000);
      const { adapter } = buildAdapter({ hits: [] }, { nowMs: NOW_MS });

      const page = await adapter.fetchBackfill(
        { since: rangeSince, until: rangeUntil },
        String(Math.floor(rangeUntil.getTime() / 1000)),
      );

      expect(page).toEqual({ documents: [], cursor: undefined });
    });
  });

  describe('checkHealth', () => {
    it('reports healthy against a 200 numeric maxitem body', async () => {
      const { adapter } = buildAdapter({ hits: [], maxItem: 40000000 }, { nowMs: NOW_MS });

      await expect(adapter.checkHealth()).resolves.toEqual({
        healthy: true,
        detail: 'Hacker News Firebase API reachable; maxitem=40000000',
      });
    });

    it('reports unhealthy, not throwing, on a definitive non-retryable 4xx (net.ts returns a Response, not a throw)', async () => {
      const transport: Transport = async () => new Response(null, { status: 404 });
      const netClient = createNetClient({ transport, sleep: async () => undefined });
      const adapter = createHackerNewsAdapter({ netClient });

      const result = await adapter.checkHealth();

      expect(result).toEqual({ healthy: false, detail: 'Hacker News Firebase API returned 404' });
    });

    it('reports unhealthy, not throwing, when every retry on a 5xx is exhausted (net.ts throws UpstreamError)', async () => {
      const transport: Transport = async () => new Response(null, { status: 500 });
      const netClient = createNetClient({
        transport,
        sleep: async () => undefined,
        retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
      });
      const adapter = createHackerNewsAdapter({ netClient });

      const result = await adapter.checkHealth();

      expect(result.healthy).toBe(false);
    });

    it('reports unhealthy, not throwing, when the network client throws', async () => {
      const failingNetClient = { request: async () => { throw new NetworkError('down'); } };
      const adapter = createHackerNewsAdapter({ netClient: failingNetClient });

      const result = await adapter.checkHealth();

      expect(result.healthy).toBe(false);
      expect(result.detail).toContain('down');
    });

    it('rethrows a non-AppError instead of swallowing it (defensive; lib/net.ts never actually does this)', async () => {
      const failingNetClient = {
        request: async () => {
          // A raw throw is legitimate here specifically because tests/** is exempt from the
          // construct-built-in-error ban (eslint.config.js) — this simulates a bug in some
          // future netClient implementation, not a case adapter.ts is expected to construct.
          throw new Error('not an AppError');
        },
      };
      const adapter = createHackerNewsAdapter({ netClient: failingNetClient });

      await expect(adapter.checkHealth()).rejects.toThrow('not an AppError');
    });
  });

  describe('query configuration', () => {
    it('sends the configured tags=(story,comment) filter and merges/dedupes hits across multiple queries', async () => {
      const sinceSec = NOW_SEC - 3600;
      const hits: FixtureHit[] = [{ objectID: '100', created_at_i: sinceSec + 100 }];
      const { adapter, calls } = buildAdapter(
        { hits, firebaseItems: { '100': firebaseStory } },
        { nowMs: NOW_MS, queries: ['alpha', 'beta'] }, // both queries match the same fixture set
      );

      const page = await adapter.fetchIncremental(undefined);

      expect(page.documents).toHaveLength(1); // deduped, not fetched twice
      const algoliaCalls = calls.filter((u) => u.includes('hn.algolia.com'));
      expect(algoliaCalls).toHaveLength(2); // one search per configured query
      expect(algoliaCalls.every((u) => new URL(u).searchParams.get('tags') === '(story,comment)')).toBe(true);
      expect(new Set(algoliaCalls.map((u) => new URL(u).searchParams.get('query')))).toEqual(
        new Set(['alpha', 'beta']),
      );
    });
  });

  it('is registered under source "hackernews"', () => {
    const { adapter } = buildAdapter({ hits: [] }, { nowMs: NOW_MS });
    expect(adapter.source).toBe('hackernews');
  });
});
