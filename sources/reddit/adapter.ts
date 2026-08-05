// The Reddit source adapter: OAuth against the free tier, configured subreddits, `new` and
// `top` listings, and bounded comment expansion on qualifying threads. See ./types.ts,
// ./auth.ts, ./http.ts, and ./mapping.ts for the pieces this file assembles.
import { netClient as sharedNetClient, type NetClient } from '../../lib/net.js';
import { AppError, ConfigError, RateLimitError, UpstreamError } from '../../lib/errors.js';
import { log } from '../../lib/log.js';
import type { Document } from '../../lib/types.js';
import type {
  BackfillRange,
  Cursor,
  FetchPageOutcome,
  HealthCheckResult,
  SourceAdapter,
} from '../types.js';
import { createTokenManager, type TokenManager } from './auth.js';
import { requestAuthed } from './http.js';
import {
  parseCommentsResponse,
  parseListingResponse,
  toPostDocument,
  walkCommentTree,
  type MappedPost,
} from './mapping.js';
import type {
  RedditAdapterOptions,
  RedditCommentExpansionOptions,
  RedditFetchPage,
  RedditRateLimitHeadroom,
  RedditTopTimeWindow,
} from './types.js';

const DEFAULT_SUBREDDITS: readonly string[] = [];
const DEFAULT_POSTS_PER_PAGE = 25;
const DEFAULT_TOP_TIME_WINDOW: RedditTopTimeWindow = 'day';
// Expansion costs one request per qualifying post, so the qualifying threshold is what
// decides how much of the 100 QPM ceiling a single listing page can spend: at
// `minCommentsToExpand: 1`, a 25-post page costs ~26 requests. Requiring 5 comments keeps
// the spend on threads carrying an actual discussion, and keeps a page's cost closer to the
// listing request itself.
const DEFAULT_COMMENT_EXPANSION: RedditCommentExpansionOptions = {
  maxDepth: 2,
  maxBreadth: 5,
  minCommentsToExpand: 5,
};

// Above this share of a listing page failing to map, the page is reported `truncated`
// rather than passed off as an ordinary (possibly empty) success. A handful of unmappable
// children is normal — Reddit listings carry promoted and placeholder entries — but a
// majority failing means the per-item shape moved under us, and silently returning fewer
// documents while the cursor marches on is how a run reports clean success having ingested
// nothing.
const MAPPING_SHORTFALL_TRUNCATION_RATIO = 0.5;

const LISTINGS = ['new', 'top'] as const;
type Listing = (typeof LISTINGS)[number];

interface SubredditListing {
  readonly subreddit: string;
  readonly listing: Listing;
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}

function isListingName(value: unknown): value is Listing {
  return typeof value === 'string' && (LISTINGS as readonly string[]).includes(value);
}

/** Where in a sweep a decoded cursor points: which entry of the configured list, and how far
 *  into that entry's own pagination. */
interface SweepPosition {
  readonly index: number;
  readonly after: string | null;
}

// --- Incremental cursor: round-robins every (subreddit, listing) pair -------------------

// Keyed on the subreddit *name*, never its position in `options.subreddits`. I-05 wires that
// list from configuration, so it will change between runs; an index-keyed cursor silently
// resolves to a different subreddit when an entry is prepended, and hard-fails a bounds
// check when one is removed.
interface IncrementalCursorState {
  readonly subreddit: string;
  readonly listing: Listing;
  readonly after: string | null;
}

function isIncrementalCursorState(value: unknown): value is IncrementalCursorState {
  const record = asRecord(value);
  return (
    record !== undefined &&
    typeof record.subreddit === 'string' &&
    isListingName(record.listing) &&
    (typeof record.after === 'string' || record.after === null)
  );
}

function encodeIncrementalCursor(pair: SubredditListing, after: string | null): Cursor {
  const state: IncrementalCursorState = { subreddit: pair.subreddit, listing: pair.listing, after };
  return JSON.stringify(state);
}

function resolveIncrementalPosition(
  cursor: Cursor | undefined,
  pairs: readonly SubredditListing[],
): SweepPosition {
  if (cursor === undefined) {
    return { index: 0, after: null };
  }
  const parsed = tryParseJson(cursor);
  if (!isIncrementalCursorState(parsed)) {
    // A cursor is opaque and adapter-minted (sources/types.ts's own doc comment) — I-05 only
    // ever replays exactly what this adapter previously returned, so an unrecognizable one
    // means either genuine corruption or a cross-wired call passing a backfill cursor in
    // here. Either way it is a wiring bug worth surfacing loudly.
    throw new ConfigError('Malformed Reddit incremental cursor', { context: { cursor } });
  }
  const index = pairs.findIndex(
    (pair) => pair.subreddit === parsed.subreddit && pair.listing === parsed.listing,
  );
  if (index === -1) {
    // A subreddit dropped from configuration between runs is a routine config edit, not a
    // wiring bug — restarting the sweep re-fetches pages already seen (free, since ingest
    // deduplicates on `(source, source_id)`) where throwing would hard-fail every run until
    // someone manually cleared the stored cursor.
    log.warn('Reddit cursor names a subreddit/listing that is no longer configured; restarting the sweep', {
      source: 'reddit',
      subreddit: parsed.subreddit,
      listing: parsed.listing,
    });
    return { index: 0, after: null };
  }
  return { index, after: parsed.after };
}

function cursorForNextPair(
  pairs: readonly SubredditListing[],
  currentIndex: number,
): Cursor | undefined {
  const next = pairs[currentIndex + 1];
  return next === undefined ? undefined : encodeIncrementalCursor(next, null);
}

// --- Backfill cursor: walks one subreddit's `new` listing at a time ---------------------

interface BackfillCursorState {
  readonly subreddit: string;
  readonly after: string | null;
}

function isBackfillCursorState(value: unknown): value is BackfillCursorState {
  const record = asRecord(value);
  return (
    record !== undefined &&
    typeof record.subreddit === 'string' &&
    record.listing === undefined &&
    (typeof record.after === 'string' || record.after === null)
  );
}

function encodeBackfillCursor(subreddit: string, after: string | null): Cursor {
  const state: BackfillCursorState = { subreddit, after };
  return JSON.stringify(state);
}

function resolveBackfillPosition(
  cursor: Cursor | undefined,
  subreddits: readonly string[],
): SweepPosition {
  if (cursor === undefined) {
    return { index: 0, after: null };
  }
  const parsed = tryParseJson(cursor);
  if (!isBackfillCursorState(parsed)) {
    throw new ConfigError('Malformed Reddit backfill cursor', { context: { cursor } });
  }
  const index = subreddits.indexOf(parsed.subreddit);
  if (index === -1) {
    log.warn('Reddit backfill cursor names a subreddit that is no longer configured; restarting the range', {
      source: 'reddit',
      subreddit: parsed.subreddit,
    });
    return { index: 0, after: null };
  }
  return { index, after: parsed.after };
}

function cursorForNextSubreddit(
  subreddits: readonly string[],
  currentIndex: number,
): Cursor | undefined {
  const next = subreddits[currentIndex + 1];
  return next === undefined ? undefined : encodeBackfillCursor(next, null);
}

// --- Shared fetch machinery ---------------------------------------------------------------

interface FetchDeps {
  readonly netClient: NetClient;
  readonly tokens: TokenManager;
  readonly userAgent: string;
  readonly commentExpansion: RedditCommentExpansionOptions;
}

interface ListingPageResult {
  readonly posts: MappedPost[];
  readonly nextAfter: string | null;
  readonly headroom: RedditRateLimitHeadroom | undefined;
  readonly truncatedReason: string | undefined;
}

async function fetchListingPage(
  subreddit: string,
  listing: Listing,
  after: string | null,
  postsPerPage: number,
  topTimeWindow: RedditTopTimeWindow,
  deps: FetchDeps,
): Promise<ListingPageResult> {
  const params = new URLSearchParams({ limit: String(postsPerPage), raw_json: '1' });
  if (after !== null) {
    params.set('after', after);
  }
  if (listing === 'top') {
    params.set('t', topTimeWindow);
  }
  const url = `https://oauth.reddit.com/r/${encodeURIComponent(subreddit)}/${listing}?${params.toString()}`;
  const { response, headroom } = await requestAuthed(url, deps);
  if (response.status === 401) {
    throw new ConfigError(
      'Reddit rejected the access token even after a refresh attempt — check REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET',
      { context: { status: 401 } },
    );
  }
  if (response.status === 403 || response.status === 404) {
    // Private, banned, or nonexistent — a configuration fact about this one entry in
    // `subreddits`, not a reason to fail the whole run, but reporting it as an ordinary
    // empty page would make a typo'd name read as a permanently clean, permanently empty
    // sweep. `truncated` is the vocabulary for "more may exist and no cursor reaches it".
    return {
      posts: [],
      nextAfter: null,
      headroom,
      truncatedReason: `Reddit returned ${response.status} for r/${subreddit}/${listing} — private, banned, or nonexistent subreddit; nothing from it is reachable`,
    };
  }
  if (!response.ok) {
    throw new UpstreamError(`Reddit listing r/${subreddit}/${listing} returned ${response.status}`, {
      context: { subreddit, listing, status: response.status },
    });
  }
  const json: unknown = await response.json();
  const { children, after: nextAfter, childCount } = parseListingResponse(json, subreddit);
  const posts = children.map((child) => toPostDocument(child)).filter((post): post is MappedPost => post !== undefined);

  const skipped = childCount - posts.length;
  if (skipped > 0) {
    // Without this, a renamed per-item field drops every child, the page comes back empty,
    // the cursor advances, and the run reports clean success having ingested nothing.
    log.warn('Reddit listing items could not be mapped to Documents', {
      source: 'reddit',
      subreddit,
      listing,
      skipped,
      total: childCount,
    });
  }
  const shortfall = childCount > 0 && skipped / childCount >= MAPPING_SHORTFALL_TRUNCATION_RATIO;
  return {
    posts,
    nextAfter,
    headroom,
    truncatedReason: shortfall
      ? `${skipped} of ${childCount} items in r/${subreddit}/${listing} did not carry the fields this adapter maps — Reddit's per-item response shape may have changed`
      : undefined,
  };
}

interface CommentThreadResult {
  readonly documents: Document[];
  readonly headroom: RedditRateLimitHeadroom | undefined;
  readonly skipped: number;
  readonly candidates: number;
}

async function fetchCommentDocuments(
  post: MappedPost,
  subreddit: string,
  deps: FetchDeps,
): Promise<CommentThreadResult> {
  const { maxDepth, maxBreadth } = deps.commentExpansion;
  const params = new URLSearchParams({
    limit: String(maxBreadth),
    depth: String(maxDepth),
    sort: 'top',
    raw_json: '1',
  });
  const url = `https://oauth.reddit.com/r/${encodeURIComponent(subreddit)}/comments/${post.postId36}?${params.toString()}`;
  const { response, headroom } = await requestAuthed(url, deps);
  if (response.status === 401) {
    throw new ConfigError(
      'Reddit rejected the access token even after a refresh attempt — check REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET',
      { context: { status: 401 } },
    );
  }
  if (response.status === 403 || response.status === 404) {
    // The thread became unavailable between the listing call and this one (deleted post,
    // newly banned subreddit) — the post Document itself is still valid evidence; there is
    // simply nothing to expand, and re-fetching would not change that.
    return { documents: [], headroom, skipped: 0, candidates: 0 };
  }
  if (!response.ok) {
    throw new UpstreamError(`Reddit comments fetch for post ${post.postId36} returned ${response.status}`, {
      context: { postId36: post.postId36, status: response.status },
    });
  }
  const json: unknown = await response.json();
  const children = parseCommentsResponse(json, post.postId36);
  const walked = walkCommentTree(children, post.permalink, maxDepth, maxBreadth);
  return { documents: walked.documents, headroom, skipped: walked.skipped, candidates: walked.candidates };
}

interface ExpansionResult {
  readonly documents: Document[];
  readonly headroom: RedditRateLimitHeadroom | undefined;
  readonly error: AppError | undefined;
  /** Unmappable `t1` children summed across every thread expanded for this page, against the
   *  children the walk attempted — see `WalkedComments` in ./mapping.ts. */
  readonly skipped: number;
  readonly candidates: number;
}

/**
 * One failed thread costs one thread, not the rest of the page: expansion continues through
 * the remaining qualifying posts and reports the first failure afterwards. A `RateLimitError`
 * is the one exception — continuing past it would only deepen the violation the bucket is
 * already reporting, so expansion stops there.
 */
async function expandQualifyingThreads(
  posts: readonly MappedPost[],
  subreddit: string,
  deps: FetchDeps,
): Promise<ExpansionResult> {
  const documents: Document[] = [];
  let headroom: RedditRateLimitHeadroom | undefined;
  let firstError: AppError | undefined;
  let skipped = 0;
  let candidates = 0;
  for (const post of posts) {
    if (post.numComments < deps.commentExpansion.minCommentsToExpand) {
      continue;
    }
    try {
      const result = await fetchCommentDocuments(post, subreddit, deps);
      documents.push(...result.documents);
      headroom = result.headroom ?? headroom;
      skipped += result.skipped;
      candidates += result.candidates;
      if (result.skipped > 0) {
        // Named per thread rather than only in the page-level total, so the log points at
        // the payload to go look at.
        log.warn('Reddit comment children could not be mapped to Documents', {
          source: 'reddit',
          subreddit,
          post_id: post.postId36,
          skipped: result.skipped,
          total: result.candidates,
        });
      }
    } catch (err) {
      if (!(err instanceof AppError)) {
        throw err;
      }
      log.warn('Reddit comment expansion failed for a thread; this page will be re-fetched rather than skipped', {
        source: 'reddit',
        subreddit,
        post_id: post.postId36,
        error: err,
      });
      if (err instanceof RateLimitError) {
        return { documents, headroom, error: err, skipped, candidates };
      }
      firstError ??= err;
    }
  }
  return { documents, headroom, error: firstError, skipped, candidates };
}

/**
 * The comment-side counterpart of the listing shortfall: a renamed `t1` field drops every
 * comment on the page, and comments are most of Reddit's document volume, so without this a
 * page can carry only its posts and still look entirely ordinary. Same ratio as the listing
 * path, because the question is the same one — did most of what arrived turn out to be
 * unreadable?
 */
function commentShortfallReason(expansion: ExpansionResult, subreddit: string): string | undefined {
  if (expansion.candidates === 0 || expansion.skipped / expansion.candidates < MAPPING_SHORTFALL_TRUNCATION_RATIO) {
    return undefined;
  }
  return `${expansion.skipped} of ${expansion.candidates} comments expanded in r/${subreddit} did not carry the fields this adapter maps — Reddit's per-item response shape may have changed`;
}

interface PageParts {
  readonly documents: Document[];
  readonly cursor: Cursor | undefined;
  readonly headroom: RedditRateLimitHeadroom | undefined;
  readonly error: AppError | undefined;
  readonly truncatedReason: string | undefined;
}

function buildRedditPage(parts: PageParts): RedditFetchPage {
  // `partial` outranks `truncated`: it is the outcome tied to the cursor not advancing, so
  // it is the one a caller must not miss. The shortfall behind a `truncated` reason is
  // logged regardless of which wins here.
  const outcome: FetchPageOutcome | undefined =
    parts.error !== undefined
      ? { kind: 'partial', error: parts.error }
      : parts.truncatedReason !== undefined
        ? { kind: 'truncated', reason: parts.truncatedReason }
        : undefined;
  // Optional keys are set only when they carry a value, never assigned `undefined`: I-05
  // reads `rateLimitHeadroom` by duck-typing, and `'rateLimitHeadroom' in page` must answer
  // the same way for every page that lacks one.
  const page: {
    documents: Document[];
    cursor: Cursor | undefined;
    outcome?: FetchPageOutcome;
    rateLimitHeadroom?: RedditRateLimitHeadroom;
  } = { documents: parts.documents, cursor: parts.cursor };
  if (outcome !== undefined) {
    page.outcome = outcome;
  }
  if (parts.headroom !== undefined) {
    page.rateLimitHeadroom = parts.headroom;
  }
  return page;
}

// --- Factory --------------------------------------------------------------------------

function hasAuth(
  options: RedditAdapterOptions,
): options is RedditAdapterOptions & { clientId: string; clientSecret: string; userAgent: string } {
  return (
    typeof options.clientId === 'string' &&
    options.clientId !== '' &&
    typeof options.clientSecret === 'string' &&
    options.clientSecret !== '' &&
    typeof options.userAgent === 'string' &&
    options.userAgent !== ''
  );
}

export function createRedditAdapter(options: RedditAdapterOptions = {}): SourceAdapter {
  const subreddits = options.subreddits ?? DEFAULT_SUBREDDITS;
  const postsPerPage = options.postsPerPage ?? DEFAULT_POSTS_PER_PAGE;
  const topTimeWindow = options.topTimeWindow ?? DEFAULT_TOP_TIME_WINDOW;
  const commentExpansion: RedditCommentExpansionOptions = {
    ...DEFAULT_COMMENT_EXPANSION,
    ...options.commentExpansion,
  };
  const net = options.netClient ?? sharedNetClient;
  const userAgent = options.userAgent ?? '';
  const pairs: readonly SubredditListing[] = subreddits.flatMap((subreddit) =>
    LISTINGS.map((listing) => ({ subreddit, listing })),
  );

  const tokens: TokenManager | undefined = hasAuth(options)
    ? createTokenManager({
        clientId: options.clientId,
        clientSecret: options.clientSecret,
        userAgent: options.userAgent,
        netClient: net,
        tokenUrl: options.tokenUrl,
        now: options.now,
      })
    : undefined;

  function requireDeps(): FetchDeps {
    if (tokens === undefined) {
      throw new ConfigError(
        'Reddit adapter has no OAuth credentials configured — clientId, clientSecret, and userAgent must all be supplied together',
      );
    }
    return { netClient: net, tokens, userAgent, commentExpansion };
  }

  async function fetchIncrementalPage(cursor: Cursor | undefined): Promise<RedditFetchPage> {
    if (pairs.length === 0) {
      // No subreddits configured (this factory's own conservative default) — caught up
      // with nothing to do, the same shape any adapter reports once genuinely exhausted.
      return { documents: [], cursor: undefined };
    }
    const position = resolveIncrementalPosition(cursor, pairs);
    const pair = pairs[position.index];
    if (pair === undefined) {
      // Unreachable given resolveIncrementalPosition's own bounds; guarded explicitly rather
      // than asserted away, since `noUncheckedIndexedAccess` types this read as optional.
      return { documents: [], cursor: undefined };
    }
    const deps = requireDeps();

    const listingResult = await fetchListingPage(
      pair.subreddit,
      pair.listing,
      position.after,
      postsPerPage,
      topTimeWindow,
      deps,
    );
    const expansion = await expandQualifyingThreads(listingResult.posts, pair.subreddit, deps);

    const documents = [...listingResult.posts.map((post) => post.document), ...expansion.documents];
    // Never advance past a page whose comments were not all fetched. Re-fetching a listing
    // page is cheap and deduplicates on `(source, source_id)`; the comments skipped by
    // advancing are gone, because nothing ever revisits a page the cursor has passed
    // (CLAUDE.md rule 1).
    //
    // Known cost, parked pending B-09: this cursor is a single position in one global
    // (subreddit × listing) round-robin, so holding it still stops **the entire Reddit
    // source**, not just the pair being swept — every other configured subreddit, and this
    // one's `top` listing, go unreached until the failing thread recovers. A loud stall
    // still beats silent evidence loss, so the reproducing cursor stays; the real fix is
    // per-subreddit cursor state, which waits for real credentials and real payloads to
    // validate against. A caller detects the stall as `cursor_out === cursor_in` together
    // with `outcome.kind === 'partial'`, and must bound pages per run so it does not spin.
    const nextCursor =
      expansion.error !== undefined
        ? encodeIncrementalCursor(pair, position.after)
        : listingResult.nextAfter !== null
          ? encodeIncrementalCursor(pair, listingResult.nextAfter)
          : cursorForNextPair(pairs, position.index);

    return buildRedditPage({
      documents,
      cursor: nextCursor,
      headroom: expansion.headroom ?? listingResult.headroom,
      error: expansion.error,
      // A broken listing shape outranks a broken comment shape: it is the more fundamental
      // signal, and the comment shortfall usually follows from it rather than standing alone.
      truncatedReason: listingResult.truncatedReason ?? commentShortfallReason(expansion, pair.subreddit),
    });
  }

  async function fetchBackfillPage(range: BackfillRange, cursor: Cursor | undefined): Promise<RedditFetchPage> {
    if (subreddits.length === 0) {
      return { documents: [], cursor: undefined };
    }
    const position = resolveBackfillPosition(cursor, subreddits);
    const subreddit = subreddits[position.index];
    if (subreddit === undefined) {
      return { documents: [], cursor: undefined };
    }
    const deps = requireDeps();

    // Only the `new` listing is walked for backfill: it is the one listing whose ordering
    // (strictly newest-first) makes a date-range boundary detectable at all. `top`'s
    // ordering is not chronological, so it cannot tell this loop when it has paged past
    // `range.since` the way `new` can.
    const listingResult = await fetchListingPage(
      subreddit,
      'new',
      position.after,
      postsPerPage,
      topTimeWindow,
      deps,
    );

    const inRange = listingResult.posts.filter(
      (post) => post.document.createdAt >= range.since && post.document.createdAt <= range.until,
    );
    // `new` orders newest-first, so a post older than `range.since` means every subsequent
    // post on this page (and every later page) is older still — nothing further in this
    // subreddit can fall inside the range.
    const passedWindow = listingResult.posts.some((post) => post.document.createdAt < range.since);

    const expansion = await expandQualifyingThreads(inRange, subreddit, deps);

    const documents = [...inRange.map((post) => post.document), ...expansion.documents];
    const exhaustedThisSubreddit = listingResult.nextAfter === null || passedWindow;
    // `cursor: undefined` is a positive claim that this range holds nothing more. A backfill
    // range is swept once, so making that claim over a page whose comments were not all
    // fetched loses them permanently — hence the reproducing cursor whenever a gap is known.
    const nextCursor =
      expansion.error !== undefined
        ? encodeBackfillCursor(subreddit, position.after)
        : exhaustedThisSubreddit
          ? cursorForNextSubreddit(subreddits, position.index)
          : encodeBackfillCursor(subreddit, listingResult.nextAfter);

    return buildRedditPage({
      documents,
      cursor: nextCursor,
      headroom: expansion.headroom ?? listingResult.headroom,
      error: expansion.error,
      truncatedReason: listingResult.truncatedReason ?? commentShortfallReason(expansion, subreddit),
    });
  }

  async function checkHealth(): Promise<HealthCheckResult> {
    if (tokens === undefined) {
      return {
        healthy: false,
        detail: 'Reddit adapter has no OAuth credentials configured (clientId/clientSecret/userAgent)',
      };
    }
    // The one place this adapter is expected to reach for a try/catch at all (I-01's own
    // report flags this asymmetry): checkHealth reports a status and must never throw,
    // unlike fetchIncremental/fetchBackfill, which let lib/net.ts's retries-exhausted
    // errors propagate by default.
    try {
      const { response } = await requestAuthed('https://oauth.reddit.com/r/test/about?raw_json=1', {
        netClient: net,
        tokens,
        userAgent,
      });
      if (response.status === 401) {
        return {
          healthy: false,
          detail: 'Reddit rejected the access token even after a refresh attempt',
        };
      }
      return { healthy: response.ok, detail: `Reddit API returned ${response.status}` };
    } catch (err) {
      if (err instanceof AppError) {
        return { healthy: false, detail: err.message };
      }
      throw err;
    }
  }

  return {
    source: 'reddit',
    fetchIncremental: fetchIncrementalPage,
    fetchBackfill: fetchBackfillPage,
    checkHealth,
  };
}
