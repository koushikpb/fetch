// The Reddit source adapter: OAuth against the free tier, configured subreddits, `new` and
// `top` listings, and bounded comment expansion on qualifying threads. See ./types.ts,
// ./auth.ts, ./http.ts, and ./mapping.ts for the pieces this file assembles.
import { netClient as sharedNetClient, type NetClient } from '../../lib/net.js';
import { AppError, ConfigError, UpstreamError } from '../../lib/errors.js';
import type { Document } from '../../lib/types.js';
import type { BackfillRange, Cursor, HealthCheckResult, SourceAdapter } from '../types.js';
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
// Conservative (composer resolution 5): 2 levels and 5 comments per level is enough to
// surface a thread's most-upvoted workarounds/complaints without turning one popular post
// into dozens of requests against a 100 QPM ceiling shared with every other subreddit and
// listing this adapter is sweeping.
const DEFAULT_COMMENT_EXPANSION: RedditCommentExpansionOptions = {
  maxDepth: 2,
  maxBreadth: 5,
  minCommentsToExpand: 1,
};

const LISTINGS = ['new', 'top'] as const;
type Listing = (typeof LISTINGS)[number];

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// --- Incremental cursor: round-robins every (subreddit, listing) pair -------------------

interface IncrementalCursorState {
  readonly pairIndex: number;
  readonly after: string | null;
}

function isIncrementalCursorState(value: unknown): value is IncrementalCursorState {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.pairIndex === 'number' &&
    (typeof record.after === 'string' || record.after === null)
  );
}

function encodeIncrementalCursor(state: IncrementalCursorState): Cursor {
  return JSON.stringify(state);
}

function decodeIncrementalCursor(cursor: Cursor | undefined, pairCount: number): IncrementalCursorState {
  if (cursor === undefined) {
    return { pairIndex: 0, after: null };
  }
  const parsed = tryParseJson(cursor);
  if (isIncrementalCursorState(parsed) && parsed.pairIndex >= 0 && parsed.pairIndex < pairCount) {
    return parsed;
  }
  // A cursor is opaque and adapter-minted (sources/types.ts's own doc comment) — I-05 only
  // ever replays exactly what this adapter previously returned, so reaching this means
  // either genuine corruption or a cross-wired call passing a backfill cursor in here (or
  // vice versa). Either way it is a wiring bug worth surfacing loudly, not silently
  // restarting from the beginning and re-fetching everything.
  throw new ConfigError('Malformed or out-of-range Reddit incremental cursor', { context: { cursor } });
}

// --- Backfill cursor: walks one subreddit's `new` listing at a time ---------------------

interface BackfillCursorState {
  readonly subredditIndex: number;
  readonly after: string | null;
}

function isBackfillCursorState(value: unknown): value is BackfillCursorState {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.subredditIndex === 'number' &&
    (typeof record.after === 'string' || record.after === null)
  );
}

function encodeBackfillCursor(state: BackfillCursorState): Cursor {
  return JSON.stringify(state);
}

function decodeBackfillCursor(cursor: Cursor | undefined, subredditCount: number): BackfillCursorState {
  if (cursor === undefined) {
    return { subredditIndex: 0, after: null };
  }
  const parsed = tryParseJson(cursor);
  if (isBackfillCursorState(parsed) && parsed.subredditIndex >= 0 && parsed.subredditIndex < subredditCount) {
    return parsed;
  }
  throw new ConfigError('Malformed or out-of-range Reddit backfill cursor', { context: { cursor } });
}

// --- Shared fetch machinery ---------------------------------------------------------------

interface FetchDeps {
  readonly netClient: NetClient;
  readonly tokens: TokenManager;
  readonly userAgent: string;
  readonly commentExpansion: RedditCommentExpansionOptions;
}

async function fetchListingPage(
  subreddit: string,
  listing: Listing,
  after: string | null,
  postsPerPage: number,
  topTimeWindow: RedditTopTimeWindow,
  deps: FetchDeps,
): Promise<{ posts: MappedPost[]; nextAfter: string | null; headroom: RedditRateLimitHeadroom | undefined }> {
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
    // Private, banned, or nonexistent subreddit — a configuration fact about this one entry
    // in `subreddits`, not a reason to fail the whole run. Reported as an exhausted, empty
    // page so the caller's pairs/subreddits loop just moves on to the next configured entry.
    return { posts: [], nextAfter: null, headroom };
  }
  if (!response.ok) {
    throw new UpstreamError(`Reddit listing r/${subreddit}/${listing} returned ${response.status}`, {
      context: { subreddit, listing, status: response.status },
    });
  }
  const json: unknown = await response.json();
  const { children, after: nextAfter } = parseListingResponse(json, subreddit);
  const posts = children.map((child) => toPostDocument(child)).filter((post): post is MappedPost => post !== undefined);
  return { posts, nextAfter, headroom };
}

async function fetchCommentDocuments(
  post: MappedPost,
  subreddit: string,
  deps: FetchDeps,
): Promise<{ documents: Document[]; headroom: RedditRateLimitHeadroom | undefined }> {
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
    // simply nothing to expand.
    return { documents: [], headroom };
  }
  if (!response.ok) {
    throw new UpstreamError(`Reddit comments fetch for post ${post.postId36} returned ${response.status}`, {
      context: { postId36: post.postId36, status: response.status },
    });
  }
  const json: unknown = await response.json();
  const children = parseCommentsResponse(json, post.postId36);
  const documents = walkCommentTree(children, post.permalink, maxDepth, maxBreadth);
  return { documents, headroom };
}

interface ExpansionResult {
  readonly documents: Document[];
  readonly headroom: RedditRateLimitHeadroom | undefined;
  readonly error: AppError | undefined;
}

/**
 * Expands every qualifying post's comment thread in sequence — the fan-out composer
 * resolution 5 describes. A thread that fails mid-sequence stops expansion there and
 * returns everything already collected (earlier threads' comments, plus every post
 * Document, added by the caller) alongside the `AppError` that stopped it, rather than
 * losing already-fetched documents to a rejected Promise.
 */
async function expandQualifyingThreads(
  posts: readonly MappedPost[],
  subreddit: string,
  deps: FetchDeps,
): Promise<ExpansionResult> {
  const documents: Document[] = [];
  let headroom: RedditRateLimitHeadroom | undefined;
  for (const post of posts) {
    if (post.numComments < deps.commentExpansion.minCommentsToExpand) {
      continue;
    }
    try {
      const result = await fetchCommentDocuments(post, subreddit, deps);
      documents.push(...result.documents);
      headroom = result.headroom ?? headroom;
    } catch (err) {
      if (err instanceof AppError) {
        return { documents, headroom, error: err };
      }
      throw err;
    }
  }
  return { documents, headroom, error: undefined };
}

function buildRedditPage(
  documents: Document[],
  cursor: Cursor | undefined,
  headroom: RedditRateLimitHeadroom | undefined,
  error: AppError | undefined,
): RedditFetchPage {
  if (error !== undefined) {
    return { documents, cursor, outcome: { kind: 'partial', error }, rateLimitHeadroom: headroom };
  }
  return headroom === undefined ? { documents, cursor } : { documents, cursor, rateLimitHeadroom: headroom };
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
  const pairs = subreddits.flatMap((subreddit) => LISTINGS.map((listing) => ({ subreddit, listing })));

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
    const state = decodeIncrementalCursor(cursor, pairs.length);
    const pair = pairs[state.pairIndex];
    if (pair === undefined) {
      // Unreachable given decodeIncrementalCursor's own bounds check; guarded explicitly
      // rather than asserted away, since `noUncheckedIndexedAccess` makes this read
      // `MappedPost | undefined` regardless of the invariant.
      return { documents: [], cursor: undefined };
    }
    const deps = requireDeps();

    const { posts, nextAfter, headroom: listingHeadroom } = await fetchListingPage(
      pair.subreddit,
      pair.listing,
      state.after,
      postsPerPage,
      topTimeWindow,
      deps,
    );
    const {
      documents: commentDocuments,
      headroom: commentHeadroom,
      error,
    } = await expandQualifyingThreads(posts, pair.subreddit, deps);

    const documents = [...posts.map((p) => p.document), ...commentDocuments];
    const nextState: IncrementalCursorState =
      nextAfter !== null ? { pairIndex: state.pairIndex, after: nextAfter } : { pairIndex: state.pairIndex + 1, after: null };
    const nextCursor = nextState.pairIndex >= pairs.length ? undefined : encodeIncrementalCursor(nextState);

    return buildRedditPage(documents, nextCursor, commentHeadroom ?? listingHeadroom, error);
  }

  async function fetchBackfillPage(range: BackfillRange, cursor: Cursor | undefined): Promise<RedditFetchPage> {
    if (subreddits.length === 0) {
      return { documents: [], cursor: undefined };
    }
    const state = decodeBackfillCursor(cursor, subreddits.length);
    const subreddit = subreddits[state.subredditIndex];
    if (subreddit === undefined) {
      return { documents: [], cursor: undefined };
    }
    const deps = requireDeps();

    // Only the `new` listing is walked for backfill: it is the one listing whose ordering
    // (strictly newest-first) makes a date-range boundary detectable at all. `top`'s
    // ordering is not chronological, so it cannot tell this loop when it has paged past
    // `range.since` the way `new` can.
    const { posts, nextAfter, headroom: listingHeadroom } = await fetchListingPage(
      subreddit,
      'new',
      state.after,
      postsPerPage,
      topTimeWindow,
      deps,
    );

    const inRange = posts.filter(
      (post) => post.document.createdAt >= range.since && post.document.createdAt <= range.until,
    );
    // `new` orders newest-first, so a post older than `range.since` means every subsequent
    // post on this page (and every later page) is older still — nothing further in this
    // subreddit can fall inside the range.
    const passedWindow = posts.some((post) => post.document.createdAt < range.since);

    const {
      documents: commentDocuments,
      headroom: commentHeadroom,
      error,
    } = await expandQualifyingThreads(inRange, subreddit, deps);

    const documents = [...inRange.map((p) => p.document), ...commentDocuments];
    const exhaustedThisSubreddit = nextAfter === null || passedWindow;
    const nextState: BackfillCursorState = exhaustedThisSubreddit
      ? { subredditIndex: state.subredditIndex + 1, after: null }
      : { subredditIndex: state.subredditIndex, after: nextAfter };
    const nextCursor = nextState.subredditIndex >= subreddits.length ? undefined : encodeBackfillCursor(nextState);

    return buildRedditPage(documents, nextCursor, commentHeadroom ?? listingHeadroom, error);
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
