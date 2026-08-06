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
import type { FetchPage } from '../../../sources/types.js';
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
  /** id -> non-200 status Firebase returns for that item's hydration (I-02-fix: class 1, "transient-failure"). Checked before `firebaseItems`. */
  readonly firebaseStatusOverrides?: Readonly<Record<string, number>>;
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
        const statusOverride = config.firebaseStatusOverrides?.[match[1]];
        if (statusOverride !== undefined) {
          return new Response(null, { status: statusOverride });
        }
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
      let totalDocuments = 0;
      for (let i = 0; i < 10; i++) {
        const page = await adapter.fetchIncremental(cursor);
        if (page.documents.length > 0 && page.documents.length < total) {
          sawCappedPage = true;
        }
        totalDocuments += page.documents.length;
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
      // An exact count, not just the <= 2 per-item bound above: a per-item bound alone
      // cannot distinguish the correct "second-highest distinct value" boundary from a
      // mutant that retreats by some other fixed amount (e.g. `max - 1`) and happens to
      // produce the same per-item duplication pattern on this fixture's spacing. Pinning the
      // exact total across the whole run (verified against this implementation, not derived
      // by hand) catches a regression in the boundary arithmetic that a looser bound would
      // pass through silently.
      expect(totalDocuments).toBe(12);
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

    it('signals outcome "truncated" when every item a capped query fetched ties one exact second', async () => {
      const sinceSec = NOW_SEC - 3600;
      const tiedSec = sinceSec + 50;
      // All six items share one exact created_at_i — the degenerate case where no distinct
      // value below the tied maximum exists to safely retreat to (collectWindow's doc
      // comment calls this "unreachable... in practice" at realistic page caps for the
      // thousands-of-items-per-second version, but the far more reachable
      // small-fetched-set version, fix round 2 handles the same way).
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
      // Fix round 2 (originally this test pinned the pre-round-2 stall as correct behavior —
      // it was not: silently returning `cursor: sinceSec` here hands a caller obeying
      // fetchIncremental's "stop once undefined" contract a cursor that reproduces this
      // identical, unproductive call forever, a hot loop against a third-party API
      // (CLAUDE.md rule 4)). No distinct value below the tie exists, so this call cannot
      // honestly claim any progress — it now reports that as a terminating signal instead.
      expect(first.cursor).toBeUndefined();
      expect(first.outcome?.kind).toBe('truncated');
      if (first.outcome?.kind === 'truncated') {
        expect(first.outcome.reason.length).toBeGreaterThan(0);
      }
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
      // maxPagesPerQuery 2: large enough that every capped call's fetched set contains a
      // genuine second distinct value, so this scenario exercises capping-with-resumption
      // through to ordinary exhaustion (cursor undefined, no outcome) rather than the
      // no-progress edge covered separately below (fix round 2's `maxPagesPerQuery: 1`
      // reproduction, "resumes across multiple capped calls until..." further down).
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
      let totalDocuments = 0;
      let lastPageOutcome: unknown;
      for (let i = 0; i < 10; i++) {
        const page = await adapter.fetchBackfill({ since: rangeSince, until: rangeUntil }, cursor);
        totalDocuments += page.documents.length;
        for (const doc of page.documents) {
          seenCounts.set(doc.sourceId, (seenCounts.get(doc.sourceId) ?? 0) + 1);
        }
        if (page.cursor === undefined) {
          lastPageOutcome = page.outcome;
          break;
        }
        cursor = page.cursor;
      }

      expect(seenCounts.size).toBe(total);
      for (const [, count] of seenCounts) {
        expect(count).toBeLessThanOrEqual(2);
      }
      // Ordinary exhaustion, not a no-progress signal: this range genuinely drains under
      // this configuration, so the terminating page must carry no `outcome` at all.
      expect(lastPageOutcome).toBeUndefined();
      // Exact total (verified by running, not derived by hand — see fix round 2's report):
      // a looser "<= 2 per item" bound alone would still pass a mutant that retreats by a
      // fixed amount other than the true second-highest-distinct value, as long as it
      // produces the same per-item duplication count on this fixture.
      expect(totalDocuments).toBe(7);
    });

    it('resumes across multiple capped calls until a genuine no-progress page is reported as truncated, rather than draining or stalling', async () => {
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
      // maxPagesPerQuery 1: as this range's remaining tail thins out, a capped call's single
      // fetched page can end up holding just one item, leaving no second distinct
      // created_at_i to retreat to. Fix round 1 alone left this call to silently reissue the
      // identical cursor forever — a hot loop against a third-party API (CLAUDE.md rule 4)
      // that a caller obeying fetchBackfill's own "stop once cursor comes back undefined"
      // contract cannot detect (identical cursor, non-empty documents, no outcome). Fix
      // round 2 reports `outcome: 'truncated'` and terminates instead. This exact scenario
      // (verified by running the adapter directly, not derived by hand) does not drain the
      // full range — it terminates after two calls having covered only 2 of 6 items.
      const { adapter } = buildAdapter(
        { hits, firebaseItems },
        { nowMs: NOW_MS, hitsPerPage: 2, maxPagesPerQuery: 1 },
      );

      const pages: FetchPage[] = [];
      let cursor: string | undefined;
      for (let i = 0; i < 10; i++) {
        const page = await adapter.fetchBackfill({ since: rangeSince, until: rangeUntil }, cursor);
        pages.push(page);
        if (page.cursor === undefined) {
          break;
        }
        cursor = page.cursor;
      }

      // Terminates in exactly two calls — not an unbounded loop, and not a silent drain that
      // happens to still reach 6/6 anyway.
      expect(pages).toHaveLength(2);
      expect(pages[0]?.cursor).toBeDefined();
      expect(pages[0]?.outcome).toBeUndefined();
      expect(pages[1]?.cursor).toBeUndefined();
      expect(pages[1]?.outcome?.kind).toBe('truncated');
      if (pages[1]?.outcome?.kind === 'truncated') {
        expect(pages[1].outcome.reason.length).toBeGreaterThan(0);
      }

      const seenIds = new Set(pages.flatMap((p) => p.documents.map((d) => d.sourceId)));
      // Real, if incomplete, progress — the first call's items are captured even though the
      // range as a whole cannot be fully drained under this configuration.
      expect(seenIds.size).toBeGreaterThan(0);
      expect(seenIds.size).toBeLessThan(total);
    });

    it('signals outcome "truncated" on a first backfill call whose entire capped fetch sits at the inclusive lower bound', async () => {
      const rangeSince = new Date((NOW_SEC - 1000) * 1000);
      const rangeUntil = new Date((NOW_SEC - 500) * 1000);
      const sinceSec = Math.floor(rangeSince.getTime() / 1000);
      // All four items land exactly on the range's own inclusive lower bound.
      // collectWindow seeds `maxSeenSec`/`secondMaxSeenSec` at `sinceSec` itself, so an item
      // AT that value takes neither the "new max" nor "new second-max" branch — the same
      // stall shape as many items tied at one second, just reachable on literally the first
      // call for a range (composer's fix-round-2 note) rather than only a later resumption.
      const hits: FixtureHit[] = Array.from({ length: 4 }, (_, i) => ({
        objectID: String(500 + i),
        created_at_i: sinceSec,
      }));
      const firebaseItems = Object.fromEntries(hits.map((h) => [h.objectID, { ...firebaseComment, id: Number(h.objectID) }]));
      const { adapter } = buildAdapter(
        { hits, firebaseItems },
        { nowMs: NOW_MS, hitsPerPage: 1, maxPagesPerQuery: 1 },
      );

      const first = await adapter.fetchBackfill({ since: rangeSince, until: rangeUntil }, undefined);

      expect(first.documents.length).toBeGreaterThan(0); // still salvages what it fetched
      expect(first.documents.length).toBeLessThan(hits.length); // did not walk every page
      expect(first.cursor).toBeUndefined();
      expect(first.outcome?.kind).toBe('truncated');
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

  describe('I-02-fix: hydration outcome classes reach the runs row (composer resolution 1)', () => {
    it('class 1 (non-200): retreats the cursor to just below the failed item, and a later run reaches it', async () => {
      const sinceSec = NOW_SEC - 3600;
      const hits: FixtureHit[] = [
        { objectID: '100', created_at_i: sinceSec + 100 }, // hydrates fine
        { objectID: 'forbidden', created_at_i: sinceSec + 200 }, // hydrates to a 403
      ];
      const { adapter } = buildAdapter(
        {
          hits,
          firebaseItems: { '100': { id: 100, type: 'story', time: sinceSec + 100, by: 'x', title: 't' } },
          firebaseStatusOverrides: { forbidden: 403 },
        },
        { nowMs: NOW_MS },
      );

      const first = await adapter.fetchIncremental(undefined);

      expect(first.documents).toHaveLength(1);
      expect(first.documents[0]?.sourceId).toBe('100');
      // Exact value, not just "less than untilSec": a mutant that retreats to `sinceSec`
      // (the network-failure catch's coarser behaviour) or that forgets the `- 1` would both
      // produce a different number here.
      expect(first.cursor).toBe(String(sinceSec + 199));
      // A lone transient failure does not by itself rise to a `runs`-row signal (composer
      // resolution 1 only asks class 2 to "count and surface"; class 1's fix is the retry
      // property proven below) — asserted so a regression that starts attaching an outcome
      // here is visible.
      expect(first.outcome).toBeUndefined();

      // A later run, against a transport where 'forbidden' now hydrates cleanly, reaches it —
      // the whole point of holding the boundary back instead of the pre-fix behaviour, which
      // let this item's timestamp be claimed as confirmed and made it permanently unreachable.
      const laterMs = NOW_MS + 20_000_000;
      const { transport: transport2 } = makeHackerNewsTransport({
        hits: [{ objectID: 'forbidden', created_at_i: sinceSec + 200 }],
        firebaseItems: { forbidden: { id: 1, type: 'story', time: sinceSec + 200, by: 'y', title: 't2' } },
      });
      const netClient2 = createNetClient({ transport: transport2, sleep: async () => undefined, now: () => laterMs });
      const adapter2 = createHackerNewsAdapter({
        netClient: netClient2,
        now: () => laterMs,
        hitsPerPage: 1000,
        maxPagesPerQuery: 5,
        indexLagBufferSeconds: 10,
        queries: [''],
      });

      const second = await adapter2.fetchIncremental(first.cursor);

      expect(second.documents.map((d) => d.sourceId)).toContain('1');
    });

    it('class 1: the boundary retreats below the *earliest* of several failures, not the latest', async () => {
      const sinceSec = NOW_SEC - 3600;
      const hits: FixtureHit[] = [
        { objectID: 'good', created_at_i: sinceSec + 50 },
        { objectID: 'bad1', created_at_i: sinceSec + 150 }, // the earlier of the two failures
        { objectID: 'bad2', created_at_i: sinceSec + 250 },
      ];
      const { adapter } = buildAdapter(
        {
          hits,
          firebaseItems: { good: { id: 1, type: 'story', time: sinceSec + 50, by: 'x', title: 't' } },
          // Only a non-retryable 4xx reaches `hydrateItem`'s own status check as a `Response`
          // (lib/net.ts's own contract) — a 5xx or 429 is retried and, once exhausted, thrown
          // as an `UpstreamError`/`RateLimitError` well before `hydrateItem` ever sees it, so
          // it is not this class at all.
          firebaseStatusOverrides: { bad1: 403, bad2: 404 },
        },
        { nowMs: NOW_MS },
      );

      const page = await adapter.fetchIncremental(undefined);

      expect(page.documents).toHaveLength(1);
      expect(page.documents[0]?.sourceId).toBe('1');
      // A mutant that retreats to the *latest* failure (Math.max instead of Math.min) would
      // produce `sinceSec + 249` here instead — a distinctly different, wrong value.
      expect(page.cursor).toBe(String(sinceSec + 149));
    });

    it('class 3 (filtered): never enters the malformed-shortfall ratio, even when it vastly outnumbers parseable attempts', async () => {
      const sinceSec = NOW_SEC - 3600;
      const jobHits: FixtureHit[] = Array.from({ length: 8 }, (_, i) => ({
        objectID: `job${i}`,
        created_at_i: sinceSec + 10 * (i + 1),
      }));
      const hits: FixtureHit[] = [
        ...jobHits,
        { objectID: 'good', created_at_i: sinceSec + 500 },
        { objectID: 'weird', created_at_i: sinceSec + 600 },
      ];
      const firebaseItems: Record<string, unknown> = {
        good: { id: 1, type: 'story', time: sinceSec + 500, by: 'x', title: 't' },
        weird: { notAnItem: true }, // malformed
        ...Object.fromEntries(jobHits.map((h) => [h.objectID, { id: 2, type: 'job', time: h.created_at_i, title: 'hiring' }])),
      };
      const { adapter } = buildAdapter({ hits, firebaseItems }, { nowMs: NOW_MS });

      const page = await adapter.fetchIncremental(undefined);

      // The *correct* ratio counts only the 2 parseable attempts (1 success, 1 malformed) —
      // 1/2 = 50%, at the threshold. A mutant that also counts the 8 filtered job postings as
      // attempts would compute 1/10 = 10%, well under threshold, and this assertion would then
      // see `outcome` absent instead of `'truncated'`.
      expect(page.outcome?.kind).toBe('truncated');
      if (page.outcome?.kind === 'truncated') {
        expect(page.outcome.reason).toContain('1 of 2');
      }
      expect(page.documents).toHaveLength(1);
      expect(page.documents[0]?.sourceId).toBe('1');
    });

    it('class 3: an entire page of filtered items alone never produces a shortfall signal, and the cursor still advances fully', async () => {
      const sinceSec = NOW_SEC - 3600;
      const hits: FixtureHit[] = Array.from({ length: 5 }, (_, i) => ({
        objectID: `job${i}`,
        created_at_i: sinceSec + 10 * (i + 1),
      }));
      const firebaseItems = Object.fromEntries(
        hits.map((h) => [h.objectID, { id: 1, type: 'job', time: h.created_at_i, title: 'hiring' }]),
      );
      const { adapter } = buildAdapter({ hits, firebaseItems }, { nowMs: NOW_MS, indexLagBufferSeconds: 10 });

      const page = await adapter.fetchIncremental(undefined);

      expect(page.documents).toHaveLength(0);
      // `parseableAttempts === 0` must not be treated as "100% malformed" by a stray division
      // — the guard against dividing by zero is what keeps a quiet-but-job-posting-heavy day
      // from reading as an outage (composer resolution 1, class 3's own warning).
      expect(page.outcome).toBeUndefined();
      expect(page.cursor).toBe(String(NOW_SEC - 10));
    });

    it('class 2 (malformed): below the shortfall ratio, advances silently — matching Reddit\'s below-threshold precedent', async () => {
      const sinceSec = NOW_SEC - 3600;
      const hits: FixtureHit[] = [
        { objectID: '1', created_at_i: sinceSec + 100 },
        { objectID: '2', created_at_i: sinceSec + 200 },
        { objectID: '3', created_at_i: sinceSec + 300 },
        { objectID: 'weird', created_at_i: sinceSec + 400 },
      ];
      const firebaseItems: Record<string, unknown> = {
        '1': { id: 1, type: 'story', time: sinceSec + 100, by: 'x', title: 't' },
        '2': { id: 2, type: 'story', time: sinceSec + 200, by: 'x', title: 't' },
        '3': { id: 3, type: 'story', time: sinceSec + 300, by: 'x', title: 't' },
        weird: { notAnItem: true },
      };
      const { adapter } = buildAdapter({ hits, firebaseItems }, { nowMs: NOW_MS });

      const page = await adapter.fetchIncremental(undefined);

      expect(page.documents).toHaveLength(3); // 1 of 4 parseable attempts malformed (25%) — under the 50% ratio
      expect(page.outcome).toBeUndefined();
      expect(page.cursor).toBe(String(NOW_SEC - 10));
    });

    it('class 2: at or above the shortfall ratio, reports "truncated" AND the cursor still advances — this is the fix', async () => {
      const sinceSec = NOW_SEC - 3600;
      const hits: FixtureHit[] = Array.from({ length: 4 }, (_, i) => ({
        objectID: `item${i}`,
        created_at_i: sinceSec + 100 * (i + 1),
      }));
      // Every item's body is missing the fields FirebaseItemSchema requires — what an
      // upstream field rename looks like (the reviewer's own reproduction).
      const firebaseItems = Object.fromEntries(hits.map((h) => [h.objectID, { renamed: true }]));
      const { adapter } = buildAdapter({ hits, firebaseItems }, { nowMs: NOW_MS });

      const page = await adapter.fetchIncremental(undefined);

      expect(page.documents).toEqual([]);
      expect(page.outcome?.kind).toBe('truncated');
      if (page.outcome?.kind === 'truncated') {
        expect(page.outcome.reason).toContain('4 of 4');
      }
      // The pre-fix `resultToPage` discarded the cursor unconditionally whenever *any*
      // outcome was set, including this one — which meant this call's genuine progress (the
      // full window was walked; nothing here is a capped-query stall) was never persisted,
      // and every subsequent run re-walked and re-reported the identical page forever. This
      // is the exact defect the reviewer's 100%-failure probe found: a mutant reverting
      // `resultToPage`/`fetchBackfill` to the pre-fix "any outcome -> cursor undefined" rule
      // makes this specific assertion fail.
      expect(page.cursor).toBe(String(NOW_SEC - 10));
    });

    it('the first incremental call ever includes an item created in exactly the initial-lookback boundary second', async () => {
      // brief item 4: the pre-fix code always used a *strictly-greater* lower bound, even on
      // the very first call, where there is no earlier call's own upper bound to avoid
      // double-counting — so an item created in exactly that second was never fetched.
      const boundarySec = NOW_SEC - 3600; // nowSec - initialLookbackSeconds, exactly
      const hits: FixtureHit[] = [{ objectID: '1', created_at_i: boundarySec }];
      const { adapter, calls } = buildAdapter(
        { hits, firebaseItems: { '1': { id: 1, type: 'story', time: boundarySec, by: 'x', title: 't' } } },
        { nowMs: NOW_MS, initialLookbackSeconds: 3600 },
      );

      const page = await adapter.fetchIncremental(undefined);

      const algoliaCall = calls.find((u) => u.includes('hn.algolia.com'));
      const numericFilters = new URL(algoliaCall ?? '').searchParams.get('numericFilters');
      expect(numericFilters).toBe(`created_at_i>=${boundarySec},created_at_i<=${NOW_SEC - 10}`);
      expect(page.documents).toHaveLength(1); // would be 0 pre-fix
    });

    describe('fetchBackfill: cursor and outcome are independent (SourceAdapter\'s own contract)', () => {
      it('a malformed shortfall that exhausts the whole range reports cursor undefined, same as App Store\'s own rule', async () => {
        const rangeSince = new Date((NOW_SEC - 1000) * 1000);
        const rangeUntil = new Date((NOW_SEC - 500) * 1000);
        const sinceSec = Math.floor(rangeSince.getTime() / 1000);
        const hits: FixtureHit[] = [
          { objectID: 'a', created_at_i: sinceSec + 100 },
          { objectID: 'b', created_at_i: sinceSec + 200 },
          { objectID: 'c', created_at_i: sinceSec + 300 },
        ];
        const firebaseItems = Object.fromEntries(hits.map((h) => [h.objectID, { renamed: true }]));
        const { adapter } = buildAdapter({ hits, firebaseItems }, { nowMs: NOW_MS });

        const page = await adapter.fetchBackfill({ since: rangeSince, until: rangeUntil }, undefined);

        expect(page.documents).toEqual([]);
        expect(page.outcome?.kind).toBe('truncated');
        // Every configured query fully walked this range in one call (uncapped), so there is
        // no other resume point being discarded — the same reasoning App Store's
        // `runFetchBackfill` already applies when `truncatedPairs` is non-empty but every pair
        // finished within `range`.
        expect(page.cursor).toBeUndefined();
      });

      it('a malformed shortfall on a call that only partly covers the range keeps a defined, resumable cursor', async () => {
        const rangeSince = new Date((NOW_SEC - 1000) * 1000);
        const rangeUntil = new Date((NOW_SEC - 500) * 1000);
        const S = Math.floor(rangeSince.getTime() / 1000);
        // 6 items; hitsPerPage 2 + maxPagesPerQuery 2 caps this call to the 4 oldest (closest
        // to `sinceSec`), leaving the 2 newest for a later call — a genuine, non-stalled
        // partial boundary (verified by running: confirmedThroughSec lands at S+150, the
        // second-highest distinct value among the 4 fetched, well short of rangeUntilSec).
        const hits: FixtureHit[] = [1, 2, 3, 4, 5, 6].map((n) => ({
          objectID: `h${n}`,
          created_at_i: S + 50 * n,
        }));
        // The 4 oldest (h1..h4) are the ones this capped call actually attempts to hydrate —
        // all malformed, tripping the shortfall ratio on exactly the items this call touched.
        const firebaseItems = Object.fromEntries(
          ['h1', 'h2', 'h3', 'h4'].map((id) => [id, { renamed: true }]),
        );
        const { adapter } = buildAdapter(
          { hits, firebaseItems },
          { nowMs: NOW_MS, hitsPerPage: 2, maxPagesPerQuery: 2 },
        );

        const page = await adapter.fetchBackfill({ since: rangeSince, until: rangeUntil }, undefined);

        expect(page.documents).toEqual([]);
        expect(page.outcome?.kind).toBe('truncated');
        // Exact value (verified by running, not derived by hand): the second-highest distinct
        // `created_at_i` among the 4 fetched items (h3, at S+150). Defined, not undefined —
        // proving `outcome` and a genuine partial-progress `cursor` coexist for this new
        // truncation path exactly as they already do for App Store's own fan-out.
        expect(page.cursor).toBe(String(S + 150));
      });
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
