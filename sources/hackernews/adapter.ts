// Hacker News adapter (SPEC I-02). Two APIs, two jobs (composer resolution 1):
//
//   - Algolia (`hn.algolia.com/api/v1/search_by_date`) is *discovery* — search by query,
//     filtered and sorted by time, giving back item ids and their `created_at_i`.
//   - Firebase (`hacker-news.firebaseio.com/v0/item/<id>.json`) is *hydration* — the
//     authoritative, current record for one item, which is also the only place `deleted`
//     and `dead` are visible (Algolia's index generally doesn't carry either flag).
//
// Every item id Algolia returns is re-fetched from Firebase before becoming a `Document`,
// rather than building documents straight from Algolia's own hit payload, specifically so
// deleted/dead/removed items are caught here regardless of whether Algolia's copy is stale.
import { z } from 'zod';
import { netClient as defaultNetClient, type NetClient } from '../../lib/net.js';
import { log } from '../../lib/log.js';
import { AppError } from '../../lib/errors.js';
import type { Document, JsonRecord } from '../../lib/types.js';
import type { BackfillRange, Cursor, FetchPage, FetchPageOutcome, SourceAdapter } from '../types.js';
import type { HackerNewsAdapterOptions } from './types.js';

const ALGOLIA_SEARCH_URL = 'https://hn.algolia.com/api/v1/search_by_date';
const FIREBASE_BASE_URL = 'https://hacker-news.firebaseio.com/v0';

// Not required by Hacker News's terms (both APIs are public and unauthenticated), but
// resolution 7 asks every adapter to identify itself where the platform's rules require
// one — sending a descriptive UA regardless costs nothing and is good API citizenship for
// the source the other two adapters are developed against.
const USER_AGENT = 'fetch-app-hackernews-adapter/0.1 (+research tool; no auth required)';

const DEFAULT_QUERIES: readonly string[] = [''];
const DEFAULT_HITS_PER_PAGE = 1000;
const DEFAULT_INITIAL_LOOKBACK_SECONDS = 24 * 60 * 60;
const DEFAULT_INDEX_LAG_BUFFER_SECONDS = 60;
const DEFAULT_MAX_PAGES_PER_QUERY = 20;

// Only the fields this adapter actually reads; unknown fields are neither required nor
// rejected (`nbHits`/`hitsPerPage`/`page`/`query`/... all vary across calls and none of them
// matter here). API responses are `unknown` until validated (wave3 shared context) — this
// is that validation, not a cast straight from `unknown` into a typed shape.
const AlgoliaHitSchema = z.object({
  objectID: z.string(),
  created_at_i: z.number(),
});

const AlgoliaResponseSchema = z.object({
  hits: z.array(AlgoliaHitSchema),
  nbPages: z.number(),
});

type AlgoliaResponse = z.infer<typeof AlgoliaResponseSchema>;

// `.passthrough()` deliberately keeps every field Firebase sent, not just the ones below —
// resolution 5 asks for "the untouched API response in raw", and a stripping schema would
// make raw lossy (silently dropping fields like `parts` on poll items) in exactly the case
// raw exists to guard against: a mapping bug discovered later needing re-normalization from
// what Hacker News actually sent, not from what this adapter's schema anticipated.
const FirebaseItemSchema = z
  .object({
    id: z.number(),
    type: z.string(),
    time: z.number(),
    by: z.string().optional(),
    deleted: z.boolean().optional(),
    dead: z.boolean().optional(),
    text: z.string().optional(),
    title: z.string().optional(),
    url: z.string().optional(),
    score: z.number().optional(),
    descendants: z.number().optional(),
    kids: z.array(z.number()).optional(),
  })
  .passthrough();

type FirebaseItem = z.infer<typeof FirebaseItemSchema>;

function jsonHeaders(): Record<string, string> {
  return { 'User-Agent': USER_AGENT };
}

async function algoliaSearch(
  net: NetClient,
  query: string,
  numericFilters: string,
  hitsPerPage: number,
  page: number,
): Promise<AlgoliaResponse> {
  const url = new URL(ALGOLIA_SEARCH_URL);
  url.searchParams.set('query', query);
  // Parenthesized comma list is Algolia's OR syntax for `tags` (verified live) — this is
  // what makes one query cover both stories and comments (SPEC I-02 criterion 1) instead of
  // needing two separate searches merged by hand.
  url.searchParams.set('tags', '(story,comment)');
  url.searchParams.set('numericFilters', numericFilters);
  url.searchParams.set('hitsPerPage', String(hitsPerPage));
  url.searchParams.set('page', String(page));

  const res = await net.request(url.toString(), { headers: jsonHeaders() });
  // lib/net.ts already turns retries-exhausted into a thrown AppError and leaves a
  // definitive 4xx as a Response to inspect (the table in wave3-shared-context.md). Algolia's
  // public search endpoint has no documented case that returns a non-retryable 4xx for a
  // well-formed request, so seeing one here means something unexpected happened upstream —
  // worth a typed error (not a bare `throw new Error`, per CLAUDE.md), but not one of the six
  // classes in lib/errors.ts, none of which fit an adapter-level "this shouldn't happen"
  // condition; `AppError` with its own code is the same pattern sources/registry.ts already
  // uses for a condition specific to this module rather than to lib/net.ts's retry contract.
  if (res.status !== 200) {
    throw new AppError(
      'HACKERNEWS_ALGOLIA_UNEXPECTED_STATUS',
      `Algolia search returned unexpected status ${res.status}`,
      { context: { status: res.status, query, page } },
    );
  }
  const json: unknown = await res.json();
  const parsed = AlgoliaResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new AppError(
      'HACKERNEWS_ALGOLIA_UNEXPECTED_SHAPE',
      'Algolia search response did not match the expected shape',
      { context: { query, page, issues: parsed.error.issues.map((issue) => issue.message) } },
    );
  }
  return parsed.data;
}

function toDocument(item: FirebaseItem): Document {
  const isStory = item.type === 'story';
  return {
    source: 'hackernews',
    sourceId: String(item.id),
    // The Hacker News discussion thread, not whatever external URL a story links to: `body`
    // below is composed from the item's own text, so the evidence URL (CLAUDE.md rule 1)
    // should point at where that text actually lives, not at a third-party page this
    // adapter never fetched or verified.
    url: `https://news.ycombinator.com/item?id=${item.id}`,
    // `by` is absent only on deleted items, which never reach this function (filtered out
    // in hydrateItem before toDocument is called) — the fallback exists purely so this stays
    // correct if Firebase's shape ever changes, not because a live path relies on it today.
    authorHandle: item.by ?? null,
    title: isStory ? (item.title ?? null) : null,
    // Not every story has self-text (link posts usually don't) and HN doesn't call that out
    // as a distinct case worth its own null — an empty body is still a valid Document per
    // lib/types.ts's non-nullable `body: string`.
    body: item.text ?? '',
    createdAt: new Date(item.time * 1000),
    engagement: isStory
      ? { points: item.score ?? 0, commentCount: item.descendants ?? 0 }
      // Hacker News does not expose a comment-level score through either API — reply count
      // is the only engagement signal a comment actually carries.
      : { replyCount: item.kids?.length ?? 0 },
    raw: item as JsonRecord,
  };
}

/**
 * Fetches and hydrates one item by id, returning `undefined` for every "no document" case
 * instead of throwing — brief resolution 3's three genuinely different paths:
 *   1. Firebase returns `200` with a literal `null` body for a missing item (verified live
 *      against a deliberately out-of-range id) — not a 404, so this is a data check, not a
 *      status check.
 *   2. `deleted: true` — the item exists but Hacker News scrubbed its content (verified live
 *      against real deleted comments; the payload keeps `id`/`time`/`type` but drops
 *      `by`/`text`).
 *   3. `dead: true` — flagged/killed but not scrubbed (verified live; still carries
 *      `by`/`text`/`title`).
 * A fourth, defensive case (an unexpected `type`, or a shape that fails validation) is not
 * one of the three the brief calls out, but is handled the same way for the same reason:
 * one item's unusual data should not abort the page.
 */
async function hydrateItem(net: NetClient, id: string): Promise<Document | undefined> {
  const res = await net.request(`${FIREBASE_BASE_URL}/item/${id}.json`, { headers: jsonHeaders() });
  if (res.status !== 200) {
    log.warn('hackernews: unexpected status hydrating item', { itemId: id, status: res.status });
    return undefined;
  }
  const json: unknown = await res.json();
  if (json === null) {
    return undefined;
  }
  const parsed = FirebaseItemSchema.safeParse(json);
  if (!parsed.success) {
    log.warn('hackernews: skipping item with unexpected shape', {
      itemId: id,
      issues: parsed.error.issues.map((issue) => issue.message),
    });
    return undefined;
  }
  const item = parsed.data;
  if (item.deleted === true || item.dead === true) {
    return undefined;
  }
  if (item.type !== 'story' && item.type !== 'comment') {
    return undefined;
  }
  return toDocument(item);
}

interface WindowResult {
  readonly documents: Document[];
  /** Only meaningful when `outcome` is absent — see the call sites. */
  readonly confirmedThroughSec: number;
  readonly outcome?: FetchPageOutcome;
}

/**
 * Walks every configured query over the closed window `(sinceSec, untilSec]` (or
 * `[sinceSec, untilSec]` when `sinceInclusive`), hydrating each discovered id via Firebase,
 * and reports exactly how much of that window it can honestly claim as covered.
 *
 * Algolia's `search_by_date` sorts newest-first with no documented way to reverse that
 * (verified live), so a query whose window has more pages than `maxPagesPerQuery` cannot
 * simply take page 0 onward — the pages closest to `sinceSec` sit at the *end* of that
 * ordering, and taking page 0 onward would silently drop the oldest still-unprocessed items
 * while jumping the cursor straight past them, forever. Fetching from the highest page
 * number downward instead means whatever pages this call skips are always the ones nearest
 * `untilSec`, i.e. what a *later* call's window will cover.
 *
 * That alone is not quite sufficient, and fix round 1 (review finding, empirically
 * reproduced) is why: `created_at_i` is a whole-second Unix timestamp, not a unique key, and
 * Algolia's own sort order gives no guarantee about which side of a page boundary two items
 * sharing the same second land on. A tie straddling exactly the cutoff between "fetched" and
 * "not fetched" used to let the reported boundary equal that shared timestamp, which — under
 * `fetchIncremental`'s *strictly-greater* lower bound (composer resolution 2) — excludes
 * anything at exactly that timestamp on every subsequent call, forever. The unfetched twin
 * was gone with no error, no log, and no way for a later run to ever reach it again.
 *
 * Fix round 1's boundary — retreat to the *second-highest distinct* `created_at_i` fetched,
 * never the maximum — is safe because the fetched pages are a contiguous, closest-to-
 * `sinceSec` chunk of the query's globally sorted result set: nothing smaller than what we
 * fetched could possibly have been excluded, so any value strictly below the maximum is
 * provably clear of the tie risk. Only the single highest value sits at the actual cut point
 * and could have an unfetched twin beyond it, so it is always left for a later call to
 * re-cover in full — together with anything else sharing that exact second, fetched or not.
 * This is "err toward re-fetching, never toward skipping": a duplicate costs one wasted
 * request (`documents`'s `(source, source_id)` uniqueness and I-05's dedup absorb it for
 * free); a skip is permanent and CLAUDE.md rule 1 does not tolerate it.
 *
 * Fix round 2 is what to do when there is no second-highest distinct value to retreat to.
 * That is *not* only the astronomically unlikely case of thousands of items sharing one
 * second (the default 20-page/1000-hitsPerPage cap would need >20,000 items in one second of
 * Hacker News activity for that) — it is far more reachably whatever leaves a capped call's
 * fetched set with a single distinct value: a shrinking backfill range's tail page, or a
 * small `maxPagesPerQuery`/`hitsPerPage` configuration, can do this with perfectly ordinary
 * data. Either way `confirmedThroughSec` collapses to the unchanged `sinceSec` — no value
 * exists to safely claim. Returning that as an ordinary cursor would hand the caller back
 * the exact token it just passed in, and a caller honoring `SourceAdapter.fetchBackfill`'s
 * own contract ("stop once it comes back undefined") would instead loop forever reissuing an
 * identical, unproductive request — a hot loop against a third-party API (CLAUDE.md rule 4),
 * not merely a stalled cursor. Detecting that condition and reporting `outcome: { kind:
 * 'truncated', reason }` instead turns it into a terminating, recordable signal I-05 can act
 * on. See the boundary-tie and no-progress-signal tests in
 * tests/sources/hackernews/adapter.test.ts for the reproductions these two rounds close.
 */
async function collectWindow(
  net: NetClient,
  queries: readonly string[],
  sinceSec: number,
  sinceInclusive: boolean,
  untilSec: number,
  hitsPerPage: number,
  maxPagesPerQuery: number,
): Promise<WindowResult> {
  const documents: Document[] = [];
  // Dedup across queries, not just within one — the same story can match more than one
  // configured search term, and Firebase should only be hit once per id per call.
  const seenIds = new Set<string>();
  let confirmedThroughSec = untilSec;
  const lowerOperator = sinceInclusive ? '>=' : '>';
  const numericFilters = `created_at_i${lowerOperator}${sinceSec},created_at_i<=${untilSec}`;
  // Fix round 2: queries whose capped fetch left no distinct value above `sinceSec` to
  // retreat to — collected so the 'truncated' reason (below) can name the actual cause
  // rather than just reporting "stuck".
  const stalledQueries: string[] = [];

  try {
    for (const query of queries) {
      const first = await algoliaSearch(net, query, numericFilters, hitsPerPage, 0);
      const totalPages = first.nbPages;
      const capped = totalPages > maxPagesPerQuery;
      const pages = capped
        ? Array.from({ length: maxPagesPerQuery }, (_, k) => totalPages - 1 - k)
        : Array.from({ length: totalPages }, (_, p) => p);

      // Only tracked when capped — an uncapped query's boundary is trivially `untilSec`
      // because every one of its pages was walked. `maxSeenSec` is the highest
      // `created_at_i` fetched; `secondMaxSeenSec` is the highest *distinct* value strictly
      // below it. The claimed boundary is the latter, never the former — see the doc
      // comment above collectWindow (fix round 1) for why the maximum alone is unsafe.
      let maxSeenSec = sinceSec;
      let secondMaxSeenSec = sinceSec;

      for (const page of pages) {
        const result = page === 0 ? first : await algoliaSearch(net, query, numericFilters, hitsPerPage, page);
        for (const hit of result.hits) {
          if (capped) {
            if (hit.created_at_i > maxSeenSec) {
              secondMaxSeenSec = maxSeenSec;
              maxSeenSec = hit.created_at_i;
            } else if (hit.created_at_i < maxSeenSec && hit.created_at_i > secondMaxSeenSec) {
              // Strictly between `secondMaxSeenSec` and `maxSeenSec` — a new second-highest.
              // An item exactly equal to `maxSeenSec` (its tie sibling) deliberately takes
              // neither branch: ties at the top never promote `secondMaxSeenSec`, which is
              // exactly what keeps the whole tied cohort excluded from this call's claim.
              secondMaxSeenSec = hit.created_at_i;
            }
          }
          if (seenIds.has(hit.objectID)) {
            continue;
          }
          seenIds.add(hit.objectID);
          const doc = await hydrateItem(net, hit.objectID);
          if (doc !== undefined) {
            documents.push(doc);
          }
        }
      }

      if (capped) {
        // The overall boundary this call can honestly report is the minimum across every
        // query's own boundary — claiming any more would mean trusting a query that was
        // capped short as if it had been fully walked.
        confirmedThroughSec = Math.min(confirmedThroughSec, secondMaxSeenSec);
        // `secondMaxSeenSec` can never fall below `sinceSec` (it is seeded there and only
        // ever reassigned to a larger observed value), so equality is the only way this
        // query contributed zero progress — see the doc comment above for why that happens
        // on perfectly ordinary data, not just pathological ones.
        if (secondMaxSeenSec <= sinceSec) {
          stalledQueries.push(query === '' ? '(default empty query)' : query);
        }
      }
    }

    if (stalledQueries.length > 0) {
      // At least one query could not advance the shared boundary this call maintains across
      // every configured query (`confirmedThroughSec` is the minimum across all of them), so
      // the call as a whole cannot honestly claim any progress. Salvage whatever was
      // hydrated, but signal `truncated` rather than minting back the same cursor the caller
      // passed in — see collectWindow's doc comment (fix round 2) for why silently doing the
      // latter is a hot-loop risk, not just an inefficiency.
      const reason =
        `hackernews: quer${stalledQueries.length === 1 ? 'y' : 'ies'} ` +
        `${stalledQueries.map((q) => `"${q}"`).join(', ')} capped at ${maxPagesPerQuery} ` +
        `page(s) per call, but the fetched set contains no created_at_i distinctly above ` +
        `${sinceSec} to safely advance to — an unfetched item may share that exact second. ` +
        `Increase maxPagesPerQuery or hitsPerPage for this configuration to make progress.`;
      return { documents, confirmedThroughSec: sinceSec, outcome: { kind: 'truncated', reason } };
    }
    return { documents, confirmedThroughSec };
  } catch (err) {
    // Fan-out failure partway through (brief's framing of this exact adapter as the
    // paradigm case for FetchPageOutcome's 'partial' variant): salvage whatever was already
    // hydrated rather than reject the whole call and lose it. Deliberately does *not*
    // attempt a partial-boundary cursor — an error here can land mid-query, mid-page, after
    // an arbitrary number of already-deduped ids, and computing a boundary that is provably
    // safe in every one of those interleavings is not worth the complexity `outcome:
    // 'partial'` already exists to make unnecessary: the next call simply re-covers this
    // same window from `sinceSec`, which is safe (re-discovering an id already inserted is
    // I-05's dedup job, not this adapter's) even if mildly wasteful.
    if (err instanceof AppError && documents.length > 0) {
      return { documents, confirmedThroughSec: sinceSec, outcome: { kind: 'partial', error: err } };
    }
    throw err;
  }
}

function resultToPage(result: WindowResult): FetchPage {
  if (result.outcome !== undefined) {
    // Neither outcome carries a resumable cursor, but for different reasons (FetchPage's own
    // doc comment draws this distinction): 'partial' means a fan-out failure cut this call
    // short, so the next call simply replays the same starting boundary from scratch;
    // 'truncated' means this call structurally cannot page any further under its current
    // configuration — see collectWindow's doc comment (fix round 2) for why minting a cursor
    // back to the caller in that second case would be a lie, not just unhelpful.
    return { documents: result.documents, cursor: undefined, outcome: result.outcome };
  }
  return { documents: result.documents, cursor: String(result.confirmedThroughSec) };
}

export function createHackerNewsAdapter(options: HackerNewsAdapterOptions = {}): SourceAdapter {
  const queries = options.queries ?? DEFAULT_QUERIES;
  const hitsPerPage = options.hitsPerPage ?? DEFAULT_HITS_PER_PAGE;
  const initialLookbackSeconds = options.initialLookbackSeconds ?? DEFAULT_INITIAL_LOOKBACK_SECONDS;
  const indexLagBufferSeconds = options.indexLagBufferSeconds ?? DEFAULT_INDEX_LAG_BUFFER_SECONDS;
  const maxPagesPerQuery = options.maxPagesPerQuery ?? DEFAULT_MAX_PAGES_PER_QUERY;
  const net = options.netClient ?? defaultNetClient;
  const now = options.now ?? Date.now;

  return {
    source: 'hackernews',

    async fetchIncremental(cursor: Cursor | undefined): Promise<FetchPage> {
      const nowSec = Math.floor(now() / 1000);
      const sinceSec = cursor === undefined ? nowSec - initialLookbackSeconds : Number(cursor);
      const untilSec = nowSec - indexLagBufferSeconds;

      if (untilSec <= sinceSec) {
        // Called again before the index-lag buffer's worth of new time has passed: there is
        // nothing safely fetchable yet. Composer resolution 2's boundary discipline
        // ("strictly-greater... pick deliberately") applies across calls, not just within
        // one — advancing past what was never actually queried would be exactly the kind of
        // silent skip that discipline exists to prevent. `cursor: undefined` here means
        // "caught up to the present" per FetchPage's own doc comment, which this literally
        // is: nothing between the last confirmed boundary and now is safe to look at yet.
        return { documents: [], cursor: undefined };
      }

      const result = await collectWindow(net, queries, sinceSec, false, untilSec, hitsPerPage, maxPagesPerQuery);
      return resultToPage(result);
    },

    async fetchBackfill(range: BackfillRange, cursor: Cursor | undefined): Promise<FetchPage> {
      const rangeSinceSec = Math.floor(range.since.getTime() / 1000);
      const rangeUntilSec = Math.floor(range.until.getTime() / 1000);
      // `range.since`/`range.until` are inclusive on both ends (BackfillRange's own
      // contract); a resumption cursor from *this adapter's own* previous page already
      // represents "confirmed through this timestamp, inclusive" (the same invariant
      // `fetchIncremental` maintains), so only the very first call for a range honors the
      // caller's inclusive lower bound — every call after that treats its own cursor as an
      // exclusive lower bound, otherwise the boundary item would be re-fetched on every
      // resumption.
      const resuming = cursor !== undefined;
      const sinceSec = resuming ? Number(cursor) : rangeSinceSec;

      if (sinceSec >= rangeUntilSec) {
        return { documents: [], cursor: undefined };
      }

      const result = await collectWindow(
        net,
        queries,
        sinceSec,
        !resuming,
        rangeUntilSec,
        hitsPerPage,
        maxPagesPerQuery,
      );
      if (result.outcome !== undefined) {
        return resultToPage(result);
      }
      const exhausted = result.confirmedThroughSec >= rangeUntilSec;
      return exhausted
        ? { documents: result.documents, cursor: undefined }
        : { documents: result.documents, cursor: String(result.confirmedThroughSec) };
    },

    async checkHealth() {
      // The one place this adapter is expected to catch (SourceAdapter's own doc comment):
      // checkHealth reports a status and must never throw, everywhere else the default is
      // to let lib/net.ts's errors propagate.
      try {
        const res = await net.request(`${FIREBASE_BASE_URL}/maxitem.json`, { headers: jsonHeaders() });
        if (!res.ok) {
          return { healthy: false, detail: `Hacker News Firebase API returned ${res.status}` };
        }
        const json: unknown = await res.json();
        if (typeof json !== 'number') {
          return {
            healthy: false,
            detail: 'Hacker News Firebase API returned an unexpected maxitem body',
          };
        }
        return { healthy: true, detail: `Hacker News Firebase API reachable; maxitem=${json}` };
      } catch (err) {
        if (err instanceof AppError) {
          return { healthy: false, detail: err.message };
        }
        throw err;
      }
    },
  };
}
