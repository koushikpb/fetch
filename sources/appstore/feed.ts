// Parsing for the iTunes customer-reviews RSS-as-JSON feed. Kept separate from adapter.ts
// so the "turn an untrusted HTTP response into typed data" concern is testable in isolation
// from the fan-out/pagination/cursor concerns adapter.ts owns.
//
// The JSON shapes below were verified against the live endpoint on 2026-08-05, not assumed:
// `https://itunes.apple.com/<territory>/rss/customerreviews/id=<appId>/sortby=mostrecent/json`
// (page 1) and the same URL with a `page=<n>/` segment inserted before `id=` for later pages.
// No XML parser dependency was needed — the JSON variant carries every field this adapter
// uses (composer resolution 4).
import { z } from 'zod';
import { log } from '../../lib/log.js';
import { UpstreamError } from '../../lib/errors.js';
import type { Document, JsonRecord } from '../../lib/types.js';
import type { AppTerritoryPair } from './types.js';

// A page holds at most 50 reviews; the feed refuses to serve past page 10, regardless of how
// many reviews the app actually has — 500 reviews is a hard, structural ceiling, not a
// default page size (SPEC I-03 criterion 3; verified live: the feed's own `link rel="last"`
// pointed at `page=10` for a high-volume app, and `page=11` onward consistently returned an
// empty feed rather than an error).
export const MAX_PAGES = 10;

function buildBaseUrl(territory: string): string {
  return `https://itunes.apple.com/${territory}/rss/customerreviews`;
}

/**
 * Builds the URL for one page of one app's reviews in one territory. Verified live: omitting
 * the page segment returns page 1; there is no working `page=1` variant — probed directly and
 * found to return an empty feed even when the equivalent no-page request for the identical
 * app succeeds (documented in the completion report as a live finding, not a guess) — so page
 * 1 deliberately never gets an explicit segment.
 */
export function buildFeedUrl(appId: string, territory: string, page: number): string {
  const base = buildBaseUrl(territory);
  return page === 1
    ? `${base}/id=${appId}/sortby=mostrecent/json`
    : `${base}/page=${page}/id=${appId}/sortby=mostrecent/json`;
}

/**
 * The App Store review page a human can visit to see the reviews this adapter draws from —
 * there is no per-review deep link in this feed (every entry's own `link` field points at the
 * same app-level URL), so this is the most specific traceable evidence URL available
 * (CLAUDE.md global rule 1).
 */
export function buildReviewsPageUrl(pair: AppTerritoryPair): string {
  return `https://apps.apple.com/${pair.territory}/app/id${pair.appId}?see-all=reviews`;
}

// Every Atom-to-JSON field in this feed is `{ label: "..." }`; a handful also carry
// `attributes`, which nothing here reads. Modeling that repeated shape once keeps the schema
// below declarative instead of restating `z.object({ label: z.string() })` nine times.
const labelSchema = z.object({ label: z.string() });

// Only the fields this adapter actually uses are required; im:voteCount/im:voteSum are
// marked optional and title defaults to absent-is-fine (Document.title is nullable per
// lib/types.ts) rather than failing the whole entry over a field this adapter doesn't need
// verbatim in every observed real response.
const reviewEntrySchema = z.object({
  id: labelSchema,
  author: z.object({ name: labelSchema }),
  updated: labelSchema,
  title: labelSchema.optional(),
  content: labelSchema,
  'im:rating': labelSchema,
  'im:voteCount': labelSchema.optional(),
  'im:voteSum': labelSchema.optional(),
});

// Only validates that `feed` exists and, if `entry` is present, that we can hand it to
// `Array.isArray` below — `entry`'s own field-level shape is validated per-item by
// `reviewEntrySchema`, entry by entry, so one malformed review doesn't invalidate the page.
const feedEnvelopeSchema = z.object({
  feed: z.object({
    // Verified live (2026-08-05, gb territory, an app with exactly one written review):
    // the Atom-to-JSON transliteration collapses a single-element `entry` list into a bare
    // object rather than a one-element array — not a defensive assumption, a captured
    // fixture (tests/fixtures/appstore/single-entry.json). `z.unknown()` here deliberately
    // does not attempt to model "object or array" as a union; normalizeEntries below does
    // that narrowing with a plain `Array.isArray` check, which handles both shapes and stays
    // simpler than encoding the same distinction twice.
    entry: z.unknown().optional(),
  }),
});

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Drops `author.uri` before an entry reaches `raw`. That field is
 * `https://itunes.apple.com/<territory>/reviews/id<N>` — `<N>` is a stable Apple customer
 * ID that survives display-name changes and resolves to that reviewer's complete review
 * history across every app they have ever reviewed. Nothing downstream reads it (`raw`
 * exists for future re-normalization, not for this field), and CLAUDE.md rule 5 forbids
 * retaining an identifier that resolves people across platforms — `author.name` (the
 * display name, already duplicated in `document.authorHandle`) is unaffected and stays.
 * Applied here, at the one place `raw` is constructed, so every later reader of the column
 * inherits the redaction rather than needing to know to filter it themselves.
 */
function stripReviewerIdentity(entry: JsonRecord): JsonRecord {
  const author = entry.author;
  if (!isJsonRecord(author) || !('uri' in author)) {
    return entry;
  }
  const authorWithoutUri = Object.fromEntries(Object.entries(author).filter(([key]) => key !== 'uri'));
  return { ...entry, author: authorWithoutUri };
}

/**
 * Parses one page's HTTP response into the raw, per-entry `unknown` values still needing
 * per-entry validation (`parseReviewEntry`). Throws `UpstreamError` only when the page as a
 * whole is unusable (not valid JSON, or missing the `feed` envelope) — an individual
 * malformed review is `parseReviewEntry`'s concern, not this function's, so one bad entry
 * never fails an entire page.
 */
export async function parseFeedEntries(response: Response, url: string): Promise<unknown[]> {
  let json: unknown;
  try {
    json = await response.json();
  } catch (err) {
    throw new UpstreamError(`App Store RSS feed returned a non-JSON body for ${url}`, {
      context: { url },
      cause: err,
    });
  }

  const result = feedEnvelopeSchema.safeParse(json);
  if (!result.success) {
    throw new UpstreamError(`App Store RSS feed response did not match the expected shape`, {
      context: { url, issues: result.error.issues.map((issue) => issue.message) },
    });
  }

  const entry = result.data.feed.entry;
  if (entry === undefined) {
    return [];
  }
  return Array.isArray(entry) ? entry : [entry];
}

export interface ParsedReview {
  readonly document: Document;
  readonly createdAt: Date;
}

/**
 * Validates and normalizes one raw feed entry into a `Document`. Returns `undefined` — after
 * logging why, so the skip is observable rather than silently swallowed (CLAUDE.md: "never
 * swallow") — for an entry that doesn't match the expected shape, has an unparseable rating,
 * or has an unparseable timestamp, rather than failing the whole page over one bad review.
 */
export function parseReviewEntry(raw: unknown, pair: AppTerritoryPair): ParsedReview | undefined {
  if (!isJsonRecord(raw)) {
    log.warn('Skipping an App Store review entry that was not a JSON object', {
      appId: pair.appId,
      territory: pair.territory,
    });
    return undefined;
  }

  const result = reviewEntrySchema.safeParse(raw);
  if (!result.success) {
    log.warn('Skipping an App Store review entry that did not match the expected shape', {
      appId: pair.appId,
      territory: pair.territory,
      issues: result.error.issues.map((issue) => issue.message),
    });
    return undefined;
  }
  const entry = result.data;

  // Criterion 2 is the reason this adapter exists: a rating that fails to parse as an
  // integer 1-5 means this entry cannot carry the one signal downstream scoring depends on,
  // so it is treated the same as any other malformed entry rather than silently defaulted.
  const rating = Number(entry['im:rating'].label);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    log.warn('Skipping an App Store review entry with an unparseable rating', {
      appId: pair.appId,
      territory: pair.territory,
      rawRating: entry['im:rating'].label,
    });
    return undefined;
  }

  const createdAt = new Date(entry.updated.label);
  if (Number.isNaN(createdAt.getTime())) {
    log.warn('Skipping an App Store review entry with an unparseable timestamp', {
      appId: pair.appId,
      territory: pair.territory,
      rawUpdated: entry.updated.label,
    });
    return undefined;
  }

  const authorHandle = entry.author.name.label.trim() === '' ? null : entry.author.name.label;
  const title = entry.title === undefined || entry.title.label.trim() === '' ? null : entry.title.label;
  const voteCount = entry['im:voteCount'] === undefined ? 0 : Number(entry['im:voteCount'].label);
  const voteSum = entry['im:voteSum'] === undefined ? 0 : Number(entry['im:voteSum'].label);

  const document: Document = {
    source: 'appstore',
    sourceId: entry.id.label,
    url: buildReviewsPageUrl(pair),
    authorHandle,
    title,
    body: entry.content.label,
    createdAt,
    // `rating` lives here, not only in `raw` (composer resolution 2) — X-02's prefilter and
    // every later scoring stage read it from here.
    engagement: { rating, voteCount, voteSum },
    // The untouched entry minus `author.uri` (stripReviewerIdentity), not `result.data` —
    // `reviewEntrySchema` only declares the fields this adapter reads, so its parsed output
    // would silently drop every other field. `raw` exists specifically so a future
    // re-normalization isn't limited to what this version of the mapping thought to keep
    // (wave 3 shared context resolution 5) — but that only extends to fields this adapter is
    // allowed to retain at all, and a permanent, cross-app resolvable customer ID (CLAUDE.md
    // rule 5) is not one of them.
    raw: stripReviewerIdentity(raw),
  };
  return { document, createdAt };
}
