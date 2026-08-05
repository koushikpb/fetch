// The seam three parallel adapter tasks (I-02 Hacker News, I-03 App Store, I-04 Reddit)
// implement directly, and the seam I-05's orchestrator calls exclusively through
// sources/registry.ts — never a concrete adapter module. `SourceAdapter` and its supporting
// types live here, not lib/types.ts, per CLAUDE.md's convention: they are not cross-
// directory (only sources/ and its own consumers need them), so they belong in this
// directory's own types.ts rather than the shared hub.
import type { Document, Source } from '../lib/types.js';

/**
 * An opaque, adapter-minted continuation token (composer resolution 3). Hacker News
 * paginates by timestamp, the App Store RSS feed by page number, Reddit by fullname — a
 * union trying to describe all three would leak each adapter's internals into the one
 * interface every other adapter and the orchestrator share. I-05 persists whatever string
 * an adapter returns and hands the same string back unexamined on the next run; only the
 * adapter that minted a given cursor ever interprets it.
 */
export type Cursor = string;

/**
 * One page of results from either `fetchIncremental` or `fetchBackfill`. `cursor` is the
 * token to pass on the *next* call to keep paging through the same query; `undefined` means
 * "nothing further right now" — for `fetchIncremental` that means caught up to the present,
 * for `fetchBackfill` it means this range is exhausted.
 */
export interface FetchPage {
  readonly documents: readonly Document[];
  readonly cursor: Cursor | undefined;
}

/**
 * Inclusive backfill window, expressed in the platform's own creation-time terms — the same
 * field `Document.createdAt` reports, so an adapter filters on it directly rather than
 * translating between two different notions of "when".
 */
export interface BackfillRange {
  readonly since: Date;
  readonly until: Date;
}

/**
 * A health check reports a status; it does not throw (composer resolution 5). I-05's
 * criterion that one adapter failing must not abort the others depends on every adapter's
 * reachability being inspectable as data, not something every caller must wrap in a
 * try/catch just to find out.
 */
export interface HealthCheckResult {
  readonly healthy: boolean;
  /** Human-readable — logged verbatim by I-05, never parsed. */
  readonly detail: string;
}

/**
 * The contract every platform adapter implements without exception (CLAUDE.md conventions:
 * "Source adapters implement SourceAdapter ... without exception"). Nothing below mentions
 * lib/net.ts directly — that is deliberate, and is what makes the lib/net.ts terminal-
 * failure contract (task brief table) natural to satisfy rather than something every
 * implementer has to remember:
 *
 * - A definitive 4xx (a deleted Hacker News item's 404, for instance) comes back from
 *   `netClient.request(...)` as an ordinary `Response` for the adapter to branch on while
 *   building a `FetchPage` — no exception involved, so no method here needs a variant
 *   return type to carry that case.
 * - Retries-exhausted (`RateLimitError`, `UpstreamError`, `NetworkError`, `TimeoutError` —
 *   all from lib/errors.ts) surfaces as a rejected Promise from whichever `netClient.request`
 *   call was in flight. Nothing in this interface catches or wraps that: it is expected to
 *   propagate out of `fetchIncremental` / `fetchBackfill` / `checkHealth` uncaught, so I-05
 *   can catch it at the call site and record that source's run as `PARTIAL` without one
 *   broken source aborting the others.
 */
export interface SourceAdapter {
  readonly source: Source;

  /**
   * One page of documents new since the last run. `cursor` is `undefined` on an adapter's
   * very first call; every later call passes back exactly the `Cursor` the previous
   * `FetchPage` returned (composer resolution 3 — I-05 never inspects or constructs one
   * itself, only stores and replays it).
   */
  fetchIncremental(cursor: Cursor | undefined): Promise<FetchPage>;

  /**
   * One page of documents whose `createdAt` falls within `range`, for backfilling history
   * predating incremental tracking. Paginates the same way as `fetchIncremental`: pass the
   * returned `cursor` back for the next page of the *same* range, and stop once it comes
   * back `undefined`. `cursor` is `undefined` on the first call for a given range.
   */
  fetchBackfill(range: BackfillRange, cursor: Cursor | undefined): Promise<FetchPage>;

  /** Reachability probe — see `HealthCheckResult`'s doc comment for why this never throws. */
  checkHealth(): Promise<HealthCheckResult>;
}
