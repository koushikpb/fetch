// Types specific to the Reddit adapter (OAuth, free tier, 100 QPM).
//
// `NetClient` is imported across directories deliberately: it is not a shared data shape the
// "no cross-directory type imports except from lib/types.ts" convention targets, but the
// mandated single path for outbound HTTP, which every network-calling module references
// directly — the same exception sources/types.ts's own header records for `AppError`.
import type { NetClient } from '../../lib/net.js';
import type { FetchPage } from '../types.js';

export interface RedditCommentExpansionOptions {
  /**
   * Total comment levels kept, *counting the top-level comments as the first level*:
   * `maxDepth: 1` keeps top-level comments only, `2` keeps top-level plus their direct
   * replies. This matches Reddit's own `depth` query param, which the same number is sent
   * as — the client-side walk in ./mapping.ts re-enforces the ceiling so the bound holds
   * even if the server ignores it, and a `kind: "more"` stub is skipped rather than
   * expanded with a further request, which is what keeps expansion to exactly one HTTP
   * request per qualifying thread.
   */
  readonly maxDepth: number;
  /**
   * Comments kept per *sibling group* — the top-level list, and separately each reply list
   * under a kept comment — highest score first (`sort=top`). The per-group budget resets on
   * each group, so one thread yields up to `maxBreadth` top-level comments plus `maxBreadth`
   * more under each of them: 30 documents at the defaults (breadth 5, depth 2), not 10. Also
   * sent as Reddit's own `limit` query param on the comments request.
   */
  readonly maxBreadth: number;
  /** A post needs at least this many comments (its own `num_comments`) before expansion
   *  spends a request on it at all. This is the knob that decides a listing page's request
   *  cost: at 1, every post with a single comment costs a request, so a 25-post page costs
   *  ~26 against a 100 QPM ceiling. */
  readonly minCommentsToExpand: number;
}

export type RedditTopTimeWindow = 'hour' | 'day' | 'week' | 'month' | 'year' | 'all';

export interface RedditAdapterOptions {
  // Individually optional so `createRedditAdapter()` constructs cleanly with no arguments: a
  // construction-time throw would fire when sources/registry.ts's array literal is evaluated
  // at module load, before any run exists to report it against. Missing credentials surface
  // lazily instead — fetchIncremental/fetchBackfill throw `ConfigError`, checkHealth reports
  // `healthy: false`, both only when actually invoked.
  readonly clientId?: string;
  readonly clientSecret?: string;
  readonly userAgent?: string;
  /**
   * Which subreddits to sweep. Defaults to none — an empty, deliberately inert adapter
   * until whoever wires this in supplies a real list. Choosing *which* subreddits Fetch
   * monitors is a product decision (composer resolution 1 leaves "queries, app IDs,
   * subreddits" to the factory caller), not something this task should hardcode.
   */
  readonly subreddits?: readonly string[];
  /** Posts requested per listing page — Reddit's own `limit` query param. */
  readonly postsPerPage?: number;
  /** Reddit's `top` listing requires a time window; unused by the `new` listing. */
  readonly topTimeWindow?: RedditTopTimeWindow;
  /** Depth/breadth bounds for comment expansion (composer resolution 5). Individual keys
   *  fall back to conservative defaults when omitted. */
  readonly commentExpansion?: Partial<RedditCommentExpansionOptions>;
  /**
   * Defaults to lib/net.ts's shared `netClient` singleton in production — the one instance
   * whose token bucket every other call in the process shares (composer resolution 1:
   * "route every call through the shared netClient... a private client with its own bucket
   * would silently double the effective rate"). Tests inject their own isolated
   * `createNetClient({ transport })` instance instead, per the shared context's "tests must
   * not touch the network."
   */
  readonly netClient?: NetClient;
  /** Overridable so tests can point token minting at a fake host instead of
   *  www.reddit.com. */
  readonly tokenUrl?: string;
  /**
   * Injectable clock (epoch ms), defaults to `Date.now` — mirrors lib/net.ts's own DI seam.
   * Lets a test drive the *proactive* refresh branch of composer resolution 2
   * deterministically; the *reactive* 401-triggered refresh (./http.ts's `requestAuthed`)
   * needs no clock at all, since it reacts to what the fake transport actually returns.
   */
  readonly now?: () => number;
}

export interface RedditRateLimitHeadroom {
  /** Parsed from `X-Ratelimit-Remaining`. */
  readonly remaining: number | undefined;
  /** Parsed from `X-Ratelimit-Used`. */
  readonly used: number | undefined;
  /** Parsed from `X-Ratelimit-Reset`, seconds until the current window resets. */
  readonly resetSeconds: number | undefined;
}

/**
 * `FetchPage` widened with the one piece of Reddit-specific data criterion 4 needs a home
 * for: capacity-planning headroom read off Reddit's own rate-limit response headers.
 * Adding a field to `FetchPage` itself is out of this task's file scope — sources/types.ts
 * is shared and composer-owned, not touched by this task. This is the same technique
 * sources/fake-adapter.ts's own `FakeSourceAdapter` uses for its `.fake` controls (a strict
 * superset, so every value here still satisfies plain `FetchPage` structurally): an adapter
 * is free to actually return the richer shape from a method whose *declared* return type is
 * the narrower `Promise<FetchPage>` (function return types are covariant), and the extra
 * field stays on the real object for a caller that knows to look for it, invisible to every
 * caller that only knows about `FetchPage`. `createRedditAdapter`'s `fetchIncremental` /
 * `fetchBackfill` do exactly this.
 *
 * Composer resolution 4: "I-05 wires it to the runs row; you make it available." Making it
 * available stops here, at this type and the values `createRedditAdapter` actually returns
 * — whether I-05's wiring ends up reading this via a duck-typed check or by widening
 * `FetchPage` itself once every wave-3 adapter's real needs are known is deliberately left
 * to that task, not decided here.
 */
export interface RedditFetchPage extends FetchPage {
  readonly rateLimitHeadroom?: RedditRateLimitHeadroom;
}
