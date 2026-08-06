// The App Store reviews adapter (SPEC I-03): iTunes RSS review feeds by app ID and
// territory. See sources/appstore/feed.ts for wire-format parsing and
// tests/sources/appstore/ for fixtures captured from the live endpoint.
import { AppError, ConfigError, UpstreamError } from '../../lib/errors.js';
import { log } from '../../lib/log.js';
import { netClient as defaultNetClient, type NetClient } from '../../lib/net.js';
import type { Document } from '../../lib/types.js';
import type { BackfillRange, Cursor, FetchPage, HealthCheckResult, SourceAdapter } from '../types.js';
import { MAX_PAGES, buildFeedUrl, parseFeedEntries, parseReviewEntry } from './feed.js';
import {
  DEFAULT_APP_IDS,
  DEFAULT_TERRITORIES,
  type AppTerritoryPair,
  type CreateAppStoreAdapterOptions,
} from './types.js';

// Not required by Apple's terms (the iTunes RSS feed is public and unauthenticated), but
// resolution 7 asks every adapter to identify itself where the platform's rules require
// one — sending a descriptive UA regardless costs nothing and is good API citizenship,
// matching Hacker News's adapter.ts (the other unauthenticated source in this codebase).
const USER_AGENT = 'fetch-app-appstore-adapter/0.1 (+research tool; no auth required)';

function requestHeaders(): Record<string, string> {
  return { 'User-Agent': USER_AGENT };
}

function pairKey(pair: AppTerritoryPair): string {
  return `${pair.appId}:${pair.territory}`;
}

function describePair(pair: AppTerritoryPair): string {
  return `${pair.appId} (${pair.territory})`;
}

function buildTruncationReason(pairs: readonly string[]): string {
  return (
    `Reached the App Store customer-reviews RSS feed's fixed pagination ceiling ` +
    `(${MAX_PAGES} pages x 50 reviews = ${MAX_PAGES * 50} reviews) for: ${pairs.join('; ')}. ` +
    `Older reviews for these app/territory pairs may exist on the App Store, but this feed ` +
    `cannot return them no matter how many times or how often it is paged.`
  );
}

// Cursors here are always exactly what this adapter minted and handed back (composer
// resolution 3: opaque, adapter-owned, replayed unexamined by I-05) — this is defensive
// against a hand-edited or corrupted persisted value degrading a run to a crash rather than
// a fresh start, not a sign the format is untrusted the way an HTTP response body is.
function decodeCursorState(cursor: Cursor | undefined): Record<string, string> {
  if (cursor === undefined) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(cursor);
  } catch (err) {
    log.warn('App Store adapter received an unparseable cursor; restarting from scratch', {
      cursor,
      error: err,
    });
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    log.warn('App Store adapter received a cursor with an unexpected shape; restarting from scratch', {
      cursor,
    });
    return {};
  }
  const state: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === 'string') {
      state[key] = value;
    }
  }
  return state;
}

function encodeCursorState(state: Readonly<Record<string, string>>): Cursor {
  return JSON.stringify(state);
}

function buildPairs(options: CreateAppStoreAdapterOptions): readonly AppTerritoryPair[] {
  const appIds = options.appIds ?? DEFAULT_APP_IDS;
  const territories = options.territories ?? DEFAULT_TERRITORIES;
  return appIds.flatMap((appId) => territories.map((territory) => ({ appId, territory })));
}

async function fetchPageEntries(client: NetClient, appId: string, territory: string, page: number): Promise<unknown[]> {
  const url = buildFeedUrl(appId, territory, page);
  const response = await client.request(url, { headers: requestHeaders() });
  if (!response.ok) {
    // Verified live (2026-08-05): an unrecognized territory 404s, while an unknown app ID
    // still returns 200 with an empty feed — so a 404 here is specifically a bad territory in
    // this adapter's own configuration, not a per-item condition to skip the way a dead HN
    // item's 404 is. `ConfigError` reflects that it is this adapter's config at fault, not the
    // upstream (judgment call — the interface doesn't mandate a specific class here, per the
    // I-01 report's own "a real adapter might treat 401 differently" note).
    if (response.status === 404) {
      throw new ConfigError(
        `App Store RSS feed returned 404 for territory "${territory}" — check the configured territory code`,
        { context: { url, territory, appId, status: response.status } },
      );
    }
    throw new UpstreamError(`App Store RSS feed returned unexpected status ${response.status} for ${url}`, {
      context: { url, status: response.status },
    });
  }
  return parseFeedEntries(response, url);
}

interface PairWalkResult {
  readonly documents: Document[];
  /** ISO timestamp of the newest review encountered this call, `undefined` if none. */
  readonly newestSeenIso: string | undefined;
  readonly hitCeiling: boolean;
}

/**
 * Walks one (app, territory) pair's pages, most-recent-first, from page 1 up to `MAX_PAGES`,
 * stopping as soon as it re-encounters `sinceIso` (already returned by an earlier call) or
 * finds an empty page (ordinary exhaustion — nothing to page into yet). Reaching `MAX_PAGES`
 * while still finding fresh entries means the structural ceiling was hit (SPEC I-03
 * criterion 3): more reviews may exist for this pair, but no page number will ever reach
 * them.
 */
async function walkIncrementalPair(
  client: NetClient,
  pair: AppTerritoryPair,
  sinceIso: string | undefined,
): Promise<PairWalkResult> {
  const documents: Document[] = [];
  let newestSeenIso: string | undefined;
  let hitCeiling = false;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const entries = await fetchPageEntries(client, pair.appId, pair.territory, page);
    if (entries.length === 0) {
      break;
    }

    let caughtUp = false;
    for (const raw of entries) {
      const parsed = parseReviewEntry(raw, pair);
      if (parsed === undefined) {
        continue;
      }
      const iso = parsed.createdAt.toISOString();
      if (newestSeenIso === undefined || iso > newestSeenIso) {
        newestSeenIso = iso;
      }
      // Sorted most-recent-first (sortby=mostrecent): once we reach the previous
      // high-water mark, every remaining entry on this and later pages was already
      // returned by an earlier call.
      if (sinceIso !== undefined && iso <= sinceIso) {
        caughtUp = true;
        break;
      }
      documents.push(parsed.document);
    }

    if (caughtUp) {
      break;
    }
    if (page === MAX_PAGES) {
      hitCeiling = true;
    }
  }

  return { documents, newestSeenIso, hitCeiling };
}

interface BackfillPairWalkResult extends PairWalkResult {
  readonly newestSeenIso: string | undefined;
}

/**
 * Same page walk as `walkIncrementalPair`, but bounded by `range` instead of a single
 * high-water mark: entries newer than `range.until` are skipped (paging continues — older
 * matches may still exist on later pages), and the walk stops once an entry older than
 * `range.since` is found (everything after it is older still). `resumeIso`, when set from an
 * earlier call's returned cursor, additionally skips anything already collected for this
 * exact range, so a retried backfill doesn't re-emit duplicates for pairs it already
 * finished.
 */
async function walkBackfillPair(
  client: NetClient,
  pair: AppTerritoryPair,
  range: BackfillRange,
  resumeIso: string | undefined,
): Promise<BackfillPairWalkResult> {
  const documents: Document[] = [];
  let newestSeenIso: string | undefined;
  let hitCeiling = false;
  const sinceIso = range.since.toISOString();
  const untilIso = range.until.toISOString();

  for (let page = 1; page <= MAX_PAGES; page++) {
    const entries = await fetchPageEntries(client, pair.appId, pair.territory, page);
    if (entries.length === 0) {
      break;
    }

    let doneWithPair = false;
    for (const raw of entries) {
      const parsed = parseReviewEntry(raw, pair);
      if (parsed === undefined) {
        continue;
      }
      const iso = parsed.createdAt.toISOString();

      if (iso < sinceIso) {
        // Everything from here on (this page and any later page) predates the requested
        // range — nothing left to find for this pair.
        doneWithPair = true;
        break;
      }
      if (resumeIso !== undefined && iso <= resumeIso) {
        // Already returned by an earlier call for this same range.
        continue;
      }
      if (newestSeenIso === undefined || iso > newestSeenIso) {
        newestSeenIso = iso;
      }
      if (iso <= untilIso) {
        documents.push(parsed.document);
      }
      // iso > untilIso: newer than the requested window (this page's most recent reviews,
      // on a historical backfill) — skip, but keep paging for older matches.
    }

    if (doneWithPair) {
      break;
    }
    if (page === MAX_PAGES) {
      hitCeiling = true;
    }
  }

  return { documents, newestSeenIso, hitCeiling };
}

async function runFetchIncremental(
  client: NetClient,
  pairs: readonly AppTerritoryPair[],
  cursor: Cursor | undefined,
): Promise<FetchPage> {
  const state = decodeCursorState(cursor);
  const nextState: Record<string, string> = { ...state };
  const documents: Document[] = [];
  const truncatedPairs: string[] = [];

  for (const pair of pairs) {
    const key = pairKey(pair);
    try {
      const result = await walkIncrementalPair(client, pair, state[key]);
      documents.push(...result.documents);
      if (result.newestSeenIso !== undefined) {
        nextState[key] = result.newestSeenIso;
      }
      if (result.hitCeiling) {
        truncatedPairs.push(describePair(pair));
      }
    } catch (err) {
      // Fan-out adapter (wave 3 shared context resolution 3 / SPEC I-03 resolution 3): one
      // territory failing partway must not discard documents already collected from pairs
      // processed before it. Only AppError subclasses are caught here — anything else is a
      // genuine bug this adapter has no business swallowing.
      if (err instanceof AppError) {
        // Fix round 1, Finding 1: an earlier pair in this same loop may already have hit the
        // pagination ceiling before this pair threw. Without carrying that forward here, a
        // persistently broken pair silently masks another pair's permanently incomplete
        // coverage on every run for as long as the break lasts.
        return {
          documents,
          cursor: encodeCursorState(nextState),
          outcome: {
            kind: 'partial',
            error: err,
            ...(truncatedPairs.length > 0 ? { truncatedReason: buildTruncationReason(truncatedPairs) } : {}),
          },
        };
      }
      throw err;
    }
  }

  const cursorOut = encodeCursorState(nextState);
  if (truncatedPairs.length > 0) {
    // Settled rule (fix round 1, Finding 2 — sources/types.ts's SourceAdapter doc comment):
    // `cursor` and `outcome` are independent. A fan-out call still has other pairs with a
    // valid high-water mark even when one pair hits the ceiling, so `cursor` stays defined
    // rather than being forced to `undefined` — discarding it would re-walk every pair from
    // scratch on every future poll.
    return {
      documents,
      cursor: cursorOut,
      outcome: { kind: 'truncated', reason: buildTruncationReason(truncatedPairs) },
    };
  }
  return { documents, cursor: cursorOut };
}

async function runFetchBackfill(
  client: NetClient,
  pairs: readonly AppTerritoryPair[],
  range: BackfillRange,
  cursor: Cursor | undefined,
): Promise<FetchPage> {
  const resumeState = decodeCursorState(cursor);
  const nextState: Record<string, string> = { ...resumeState };
  const documents: Document[] = [];
  const truncatedPairs: string[] = [];

  for (const pair of pairs) {
    const key = pairKey(pair);
    try {
      const result = await walkBackfillPair(client, pair, range, resumeState[key]);
      documents.push(...result.documents);
      if (result.newestSeenIso !== undefined) {
        nextState[key] = result.newestSeenIso;
      }
      if (result.hitCeiling) {
        truncatedPairs.push(describePair(pair));
      }
    } catch (err) {
      if (err instanceof AppError) {
        // Unlike fetchIncremental, a defined cursor here is a genuine resume point (skip
        // already-collected reviews for this exact range on retry) rather than an ongoing
        // polling mark, so this is the one 'partial' case where cursor stays defined.
        //
        // Fix round 1, Finding 1: carry forward any earlier pair's ceiling the same way
        // fetchIncremental does — an early return here must not drop it either.
        return {
          documents,
          cursor: encodeCursorState(nextState),
          outcome: {
            kind: 'partial',
            error: err,
            ...(truncatedPairs.length > 0 ? { truncatedReason: buildTruncationReason(truncatedPairs) } : {}),
          },
        };
      }
      throw err;
    }
  }

  if (truncatedPairs.length > 0) {
    // Settled rule (fix round 1, Finding 2): every pair was fully processed within `range`
    // this call, so `cursor: undefined` correctly means "no follow-up call left to make" —
    // unlike fetchIncremental's fan-out, there is no other pair's resume point to preserve.
    return {
      documents,
      cursor: undefined,
      outcome: { kind: 'truncated', reason: buildTruncationReason(truncatedPairs) },
    };
  }
  return { documents, cursor: undefined };
}

async function runCheckHealth(client: NetClient, pairs: readonly AppTerritoryPair[]): Promise<HealthCheckResult> {
  const [pair] = pairs;
  if (pair === undefined) {
    return { healthy: false, detail: 'App Store adapter has no configured app IDs or territories' };
  }
  try {
    const url = buildFeedUrl(pair.appId, pair.territory, 1);
    const response = await client.request(url, { headers: requestHeaders() });
    return {
      healthy: response.ok,
      detail: `App Store RSS feed returned ${response.status} for app ${pair.appId} (${pair.territory})`,
    };
  } catch (err) {
    // The one method with a stricter contract than "let it propagate" (HealthCheckResult's
    // doc comment / the I-01 report's worked example): reports a status, never throws.
    if (err instanceof AppError) {
      return { healthy: false, detail: err.message };
    }
    throw err;
  }
}

/**
 * Builds the App Store reviews adapter. `options.appIds` x `options.territories` is the
 * cross-product this adapter fans out across on every `fetchIncremental`/`fetchBackfill`
 * call (SPEC I-03 criterion 1).
 */
export function createAppStoreAdapter(options: CreateAppStoreAdapterOptions = {}): SourceAdapter {
  const pairs = buildPairs(options);
  const client = options.netClient ?? defaultNetClient;

  return {
    source: 'appstore',
    fetchIncremental: (cursor) => runFetchIncremental(client, pairs, cursor),
    fetchBackfill: (range, cursor) => runFetchBackfill(client, pairs, range, cursor),
    checkHealth: () => runCheckHealth(client, pairs),
  };
}
