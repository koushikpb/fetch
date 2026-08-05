// The seam three parallel adapter tasks (I-02 Hacker News, I-03 App Store, I-04 Reddit)
// implement directly, and the seam I-05's orchestrator calls exclusively through
// sources/registry.ts — never a concrete adapter module. `SourceAdapter` and its supporting
// types live here, not lib/types.ts, per CLAUDE.md's convention: they are not cross-
// directory (only sources/ and its own consumers need them), so they belong in this
// directory's own types.ts rather than the shared hub.
//
// `AppError` (below) is the one exception to "not cross-directory": CLAUDE.md separately
// and explicitly requires every module to "throw typed errors from lib/errors.ts", so a
// type reaching for that taxonomy isn't the kind of cross-directory data-shape coupling the
// types.ts convention targets — see lib/types.ts's own equivalent import from db/schema.ts
// for the same reasoning applied to that file's compile-time assertions.
import type { AppError } from '../lib/errors.js';
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
 * Why a page ended up short of "collected everything this call could reach, cleanly" —
 * absent (`FetchPage.outcome` simply not set) is the ordinary case and needs no explanation.
 * Fix round 1, Finding 3: without this, the interface had no vocabulary for two real cases
 * three adapters will hit —
 *
 * 1. `'truncated'`: the source itself has a hard structural ceiling the adapter categorically
 *    cannot page past — not "nothing more exists right now" (that's ordinary exhaustion,
 *    `cursor: undefined` with no `outcome`), but "more exists and no cursor will ever reach
 *    it" (I-03's App Store criterion: the RSS feed's fixed 500-review pagination limit).
 *    Conflating the two would make I-05 unable to tell "caught up" from "structurally
 *    capped, will report the same ceiling again next run" — the first needs no action, the
 *    second is worth recording on the `runs` row so a human can eventually notice a review
 *    stream neither this adapter nor a future run can ever fully reach.
 * 2. `'partial'`: collection stopped partway through this page because of a thrown error —
 *    the enclosing `FetchPage.documents` holds whatever was already gathered, not nothing.
 *    Matters for fan-out adapters (Hacker News walking individual item IDs one by one,
 *    Reddit expanding comment threads breadth/depth-first): letting a `RateLimitError` or
 *    `NetworkError` on item 40 of 50 reject the whole call, the way the default "let
 *    lib/net.ts's errors propagate" pattern does, throws away the 39 already-fetched
 *    documents along with it, and a re-run re-fetches all 50 from scratch. Returning them
 *    with `outcome: { kind: 'partial', error }` instead is strictly additive: an adapter
 *    with nothing worth salvaging (the first item itself fails) should keep just throwing —
 *    `SourceAdapter`'s doc comment below still describes that as the default, expected path.
 */
export type FetchPageOutcome =
  | {
      readonly kind: 'truncated';
      /** Human-readable — recorded on the `runs` row verbatim by I-05, never parsed. */
      readonly reason: string;
    }
  | {
      readonly kind: 'partial';
      /**
       * The error that stopped this page — always one of lib/errors.ts's `AppError`
       * subclasses (`RateLimitError`, `UpstreamError`, `NetworkError`, `TimeoutError`, ...),
       * i.e. exactly what would otherwise have been thrown and lost.
       */
      readonly error: AppError;
    };

/**
 * One page of results from either `fetchIncremental` or `fetchBackfill`. `cursor` is the
 * token to pass on the *next* call to keep paging through the same query; `undefined` means
 * "nothing further right now" — for `fetchIncremental` that means caught up to the present,
 * for `fetchBackfill` it means this range is exhausted — *unless* `outcome.kind` is
 * `'truncated'`, in which case `undefined` here means "cannot page any further", a
 * categorically different reason than ordinary exhaustion (see `FetchPageOutcome`).
 *
 * `outcome` is an optional key, not a required `| undefined` field like `cursor` — unlike
 * `cursor`, which is a concept every page has an answer for (even if that answer is "none"),
 * `outcome` applies to a page 0 or 1 times: absent is not "unknown", it's "nothing
 * noteworthy happened", which is the overwhelming common case every adapter's happy path
 * hits on every ordinary call.
 */
export interface FetchPage {
  readonly documents: readonly Document[];
  readonly cursor: Cursor | undefined;
  readonly outcome?: FetchPageOutcome;
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
 *   all from lib/errors.ts) is the *default* case expected to surface as a rejected Promise
 *   from whichever `netClient.request` call was in flight, propagating out of
 *   `fetchIncremental` / `fetchBackfill` / `checkHealth` uncaught, so I-05 can catch it at
 *   the call site and record that source's run as `PARTIAL` without one broken source
 *   aborting the others. An adapter facing this partway through a fan-out page (walking
 *   individual item IDs, expanding comment threads) has a second, purely additive option
 *   when it already holds documents worth not losing: catch it locally and return
 *   `{ documents: <whatever was already collected>, cursor, outcome: { kind: 'partial',
 *   error } }` instead of letting the rejection discard them (see `FetchPageOutcome`). Both
 *   are valid on every call; nothing requires the second, and an adapter with nothing yet
 *   worth salvaging should keep just throwing.
 * - A structural pagination ceiling the adapter can never fetch past (I-03's App Store
 *   500-review RSS limit) is a third case: not a thrown error, and not ordinary exhaustion
 *   either. Return `{ documents, cursor: undefined, outcome: { kind: 'truncated', reason } }`
 *   so I-05 can tell "caught up" apart from "structurally capped" and record the latter.
 *
 * `checkHealth` is the one method with a stricter rule than "let it propagate": see
 * `HealthCheckResult`'s doc comment for why it must never throw at all, not even the
 * default case above.
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
