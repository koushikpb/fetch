// Types specific to the Hacker News adapter (Algolia search API + Firebase item API).
//
// `NetClient` is imported cross-directory the same way sources/types.ts imports `AppError`
// from lib/errors.ts: CLAUDE.md explicitly names lib/net.ts as the one wrapper every
// outbound call goes through, so referencing its exported shape here isn't the kind of
// cross-directory data-shape coupling the "types.ts convention" targets — it's a reference
// to the one designated seam, not to some other module's internal data model. `Document`
// (below) is the same exception CLAUDE.md's convention explicitly carves out for
// `lib/types.ts` itself.
import type { NetClient } from '../../lib/net.js';
import type { Document } from '../../lib/types.js';

/**
 * What `hydrateItem` (adapter.ts) learned about one Algolia hit — I-02-fix, composer
 * resolution 1: the whole-branch review found that collapsing every "no document" case into
 * a bare `undefined` let a cursor advance past evidence that was never actually fetched,
 * because the caller could not tell a transient miss from a permanent one. Four cases, not
 * three, because two of the original code's `undefined` paths (a `200`-with-null-body
 * missing item, and `deleted`/`dead` content) were already deliberate non-ingestion — the
 * brief's own three-way split names only the paths that actually needed to start behaving
 * differently:
 *
 *  - `'document'`: hydrated cleanly, ready to become a `Document`.
 *  - `'filtered'`: a *deliberate* exclusion — an item this adapter does not ingest
 *    (`type` outside `story`/`comment`, e.g. `job`/`poll`/`pollopt`), a `200`-with-null-body
 *    missing item, or `deleted`/`dead` content. None of these are a loss, so the boundary
 *    advances past them freely and they never enter the shortfall accounting below
 *    (composer resolution 1, class 3 — "getting this wrong makes a quiet HN day look like an
 *    outage").
 *  - `'transient-failure'`: Firebase answered with something other than `200` for this one
 *    item. This might resolve itself on a later attempt, so the caller must not let the
 *    boundary advance past it — "err toward re-fetching, never toward skipping" (composer
 *    resolution 1, class 1).
 *  - `'malformed'`: the body came back `200` but failed `FirebaseItemSchema.safeParse` — a
 *    deterministic failure that will not resolve by retrying (what an upstream field rename
 *    looks like), so holding the boundary would wedge the source forever on one bad item.
 *    The caller advances past it, but must count and surface it once enough of a call's
 *    items look like this — Reddit's `MAPPING_SHORTFALL_TRUNCATION_RATIO` precedent
 *    (composer resolution 1, class 2).
 */
export type HydrationOutcome =
  | { readonly kind: 'document'; readonly document: Document }
  | { readonly kind: 'filtered' }
  | { readonly kind: 'transient-failure'; readonly status: number }
  | { readonly kind: 'malformed' };

/**
 * Factory configuration (composer resolution 1 — adapters take their configuration as
 * factory parameters, never `lib/config.ts`). Every field has a workable default so
 * `createHackerNewsAdapter()` with no arguments builds an adapter usable in tests and the
 * live health check; real ingestion wiring (I-05) is expected to supply deliberate
 * `queries`.
 */
export interface HackerNewsAdapterOptions {
  /**
   * Algolia search terms (SPEC I-02: "fetches stories and comments matching configured
   * queries"). Each query is issued independently against `search_by_date` and the results
   * are merged and deduplicated by item id — a story or comment can legitimately match more
   * than one configured term. An empty string matches everything (verified live: HN's
   * Algolia API accepts `query=` and returns unfiltered results), which is why the default
   * below is `['']` rather than requiring at least one non-empty term — a caller who wants
   * "everything" doesn't have to special-case that as "no queries configured".
   */
  readonly queries?: readonly string[];

  /**
   * Algolia `hitsPerPage` for every search request. Verified live: the API silently clamps
   * anything above 1000 down to 1000 regardless of what's requested, so that is this
   * option's default — it minimizes the number of pages a call has to walk without needing
   * to guess at an undocumented ceiling.
   */
  readonly hitsPerPage?: number;

  /**
   * How far back `fetchIncremental` looks on its very first call (`cursor` is `undefined`).
   * Incremental fetching is about *new* content, not full history — that is
   * `fetchBackfill`'s job — so a fresh adapter seeds its starting boundary at "now minus
   * this many seconds" rather than Unix epoch 0, which would otherwise make the first
   * incremental call try to walk the entirety of Hacker News history. Default 24h.
   */
  readonly initialLookbackSeconds?: number;

  /**
   * Safety margin subtracted from "now" before a window becomes eligible to fetch, so an
   * incremental call never queries a range so recent that Algolia's search index may not
   * have finished indexing it yet. Without this, a call could advance its cursor past the
   * boundary of an item that exists in Hacker News but hasn't reached the search index yet,
   * permanently orphaning it — the cursor would never revisit a timestamp it has already
   * claimed as fetched. Default 60s.
   */
  readonly indexLagBufferSeconds?: number;

  /**
   * Safety cap on how many Algolia pages a single call walks per query. Hacker News's
   * search_by_date index sorts newest-first, so once a query's result window has more pages
   * than this, the adapter fetches the pages closest to the window's lower boundary first
   * (see adapter.ts's `collectWindow`) and returns a cursor that only claims the range it
   * actually covered — never the pages it skipped past. Default 20 (20,000 items at the
   * default `hitsPerPage`), comfortably above what a normally-scheduled incremental run
   * should ever accumulate between polls.
   */
  readonly maxPagesPerQuery?: number;

  /**
   * Injected network client (composer resolution 3: tests inject a fake transport rather
   * than touching the network). Defaults to `lib/net.ts`'s shared `netClient` — production
   * code should not need to pass this.
   */
  readonly netClient?: NetClient;

  /**
   * Injected clock, in epoch milliseconds — mirrors `lib/net.ts`'s own `now` option so tests
   * can pin "now" instead of depending on the real wall clock. Defaults to `Date.now`.
   */
  readonly now?: () => number;
}
