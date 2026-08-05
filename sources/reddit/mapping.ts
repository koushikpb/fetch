// Turns Reddit's raw, `unknown` JSON into `Document`s. Every payload here starts life as
// `unknown` (composer resolution: "API responses are unknown until you validate them; do
// not cast an untrusted payload straight into a typed shape") — the functions below narrow
// defensively field by field rather than asserting a shape onto the response.
import { UpstreamError } from '../../lib/errors.js';
import type { Document } from '../../lib/types.js';

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' ? value : undefined;
}

/**
 * Reddit represents "no identifiable author" as the literal string `"[deleted]"` rather than
 * a null/absent field. Collapsing that (and a missing/blank field) to `null` — rather than
 * storing the literal string — is what keeps a deleted account from reading as a real,
 * distinguishable handle downstream; `Document.authorHandle`'s own doc comment ("a deleted
 * or anonymized account still has a document worth keeping") is written for exactly this
 * case.
 */
export function normalizeAuthor(author: unknown): string | null {
  if (typeof author !== 'string' || author === '' || author === '[deleted]') {
    return null;
  }
  return `u/${author}`;
}

export interface ParsedListing {
  readonly children: readonly Record<string, unknown>[];
  readonly after: string | null;
  /** Entries in the raw `children` array, before any were dropped for not carrying a `data`
   *  record. Reported separately so the caller can tell "Reddit returned nothing" from
   *  "Reddit returned items this adapter could not read" — the two are indistinguishable
   *  from `children.length` alone, and only the second is a defect. */
  readonly childCount: number;
}

/** Validates and unwraps a Reddit `Listing` (`{kind: "Listing", data: {children, after}}`),
 *  used by both the `new`/`top` post listings and the `about` health probe's response
 *  shape. Throws `UpstreamError` — not a silent empty result — when the top-level shape
 *  itself is unrecognizable, since that means the API contract broke in a way no amount of
 *  per-field defaulting below can paper over; a single malformed *child* is handled more
 *  leniently by the per-item mapping functions instead, which skip rather than fail. */
export function parseListingResponse(json: unknown, subreddit: string): ParsedListing {
  const root = asRecord(json);
  const data = root === undefined ? undefined : asRecord(root.data);
  const children = data?.children;
  if (data === undefined || !Array.isArray(children)) {
    throw new UpstreamError(`Reddit listing response for r/${subreddit} was not the expected Listing shape`, {
      context: { subreddit },
    });
  }
  const childRecords = children
    .map((child) => asRecord(child))
    .filter((child): child is Record<string, unknown> => child !== undefined)
    .map((child) => asRecord(child.data))
    .filter((childData): childData is Record<string, unknown> => childData !== undefined);
  const after = typeof data.after === 'string' ? data.after : null;
  return { children: childRecords, after, childCount: children.length };
}

export interface MappedPost {
  readonly document: Document;
  /** Base-36 id (no `t3_` prefix) — what the `/comments/{id}` endpoint expects. */
  readonly postId36: string;
  readonly permalink: string;
  readonly numComments: number;
}

/** Returns `undefined` (never throws) for a child missing a field this mapping treats as
 *  required — Reddit listings occasionally include non-post entries (promoted content,
 *  etc.) that do not carry every field a normal post does; skipping one such child is not a
 *  reason to fail the whole page. */
export function toPostDocument(postData: Record<string, unknown>): MappedPost | undefined {
  const id36 = stringField(postData, 'id');
  const name = stringField(postData, 'name');
  const permalink = stringField(postData, 'permalink');
  const title = stringField(postData, 'title');
  const createdUtc = numberField(postData, 'created_utc');
  if (id36 === undefined || name === undefined || permalink === undefined || title === undefined || createdUtc === undefined) {
    return undefined;
  }
  const selftext = stringField(postData, 'selftext') ?? '';
  const score = numberField(postData, 'score') ?? 0;
  const numComments = numberField(postData, 'num_comments') ?? 0;
  const upvoteRatio = numberField(postData, 'upvote_ratio');
  const document: Document = {
    source: 'reddit',
    sourceId: name,
    url: `https://www.reddit.com${permalink}`,
    authorHandle: normalizeAuthor(postData.author),
    title,
    body: selftext,
    createdAt: new Date(createdUtc * 1000),
    engagement: upvoteRatio === undefined ? { score, numComments } : { score, numComments, upvoteRatio },
    // The untouched API response (shared context resolution 5) — re-normalization later
    // does not depend on this task having picked the right subset of fields up front.
    raw: postData,
  };
  return { document, postId36: id36, permalink, numComments };
}

export interface MappedComment {
  readonly document: Document;
  /** The raw `replies` node — `""` when there are none, otherwise a nested `Listing` —
   *  handed back rather than consumed here so `walkCommentTree` (below) decides whether
   *  bounded recursion should follow it. */
  readonly repliesNode: unknown;
}

export function toCommentDocument(commentData: Record<string, unknown>, postPermalink: string): MappedComment | undefined {
  const id36 = stringField(commentData, 'id');
  const name = stringField(commentData, 'name');
  const body = stringField(commentData, 'body');
  const createdUtc = numberField(commentData, 'created_utc');
  if (id36 === undefined || name === undefined || body === undefined || createdUtc === undefined) {
    return undefined;
  }
  // Reddit does not always include `permalink` on a nested comment — constructing it from
  // the parent post's own permalink (which every caller here already has) is the same
  // fallback Reddit's own web client uses.
  const permalink = stringField(commentData, 'permalink') ?? `${postPermalink}${id36}/`;
  const score = numberField(commentData, 'score') ?? 0;
  // `replies` is excluded from `raw`, not because it is sensitive (composer resolution 6's
  // "rich user object" concern does not apply to it), but because every reply it would
  // embed is *already* its own separate Document elsewhere in this same page — storing the
  // full subtree again here would duplicate that data once per ancestor level, compounding
  // with thread depth for no benefit. This mirrors a listing page's own `raw` per post,
  // which likewise holds only that post's own data node, not its sibling posts.
  const { replies, ...rawWithoutReplies } = commentData;
  const document: Document = {
    source: 'reddit',
    sourceId: name,
    url: `https://www.reddit.com${permalink}`,
    authorHandle: normalizeAuthor(commentData.author),
    title: null,
    body,
    createdAt: new Date(createdUtc * 1000),
    engagement: { score },
    raw: rawWithoutReplies,
  };
  return { document, repliesNode: replies };
}

/**
 * Bounded, request-free walk of a comments-thread response already in hand — the depth/
 * breadth ceiling (composer resolution 5) is enforced here in memory, in addition to being
 * sent as Reddit's own `depth`/`limit` query params on the request that produced `children`,
 * so the bound holds even if the server ever returns more than asked. A `kind: "more"` stub
 * (Reddit's placeholder for replies it did not inline) is skipped, never expanded with a
 * further request — that is what keeps comment expansion to exactly one HTTP call per
 * qualifying thread, never a second call per omitted subtree.
 */
export function walkCommentTree(
  children: readonly unknown[],
  postPermalink: string,
  maxDepth: number,
  maxBreadth: number,
  depth = 0,
): Document[] {
  if (depth >= maxDepth) {
    return [];
  }
  const documents: Document[] = [];
  let taken = 0;
  for (const child of children) {
    if (taken >= maxBreadth) {
      break;
    }
    const childRecord = asRecord(child);
    if (childRecord === undefined || childRecord.kind !== 't1') {
      continue;
    }
    const data = asRecord(childRecord.data);
    if (data === undefined) {
      continue;
    }
    const mapped = toCommentDocument(data, postPermalink);
    if (mapped === undefined) {
      continue;
    }
    documents.push(mapped.document);
    taken += 1;
    const repliesRecord = asRecord(mapped.repliesNode);
    const repliesData = repliesRecord === undefined ? undefined : asRecord(repliesRecord.data);
    const repliesChildren = repliesData?.children;
    if (Array.isArray(repliesChildren)) {
      documents.push(...walkCommentTree(repliesChildren, postPermalink, maxDepth, maxBreadth, depth + 1));
    }
  }
  return documents;
}

/** Only the second element of Reddit's `[postListing, commentsListing]` pair is read: the
 *  first duplicates the post this thread belongs to, already captured from the listing page.
 *  Throws `UpstreamError` on an unrecognizable top-level shape, for the same reason
 *  `parseListingResponse` does. */
export function parseCommentsResponse(json: unknown, postId36: string): readonly unknown[] {
  if (!Array.isArray(json) || json.length < 2) {
    throw new UpstreamError(`Reddit comments response for post ${postId36} was not the expected two-Listing shape`, {
      context: { postId36 },
    });
  }
  const commentsListing = asRecord(json[1]);
  const data = commentsListing === undefined ? undefined : asRecord(commentsListing.data);
  const children = data?.children;
  if (!Array.isArray(children)) {
    throw new UpstreamError(`Reddit comments response for post ${postId36} had no comment children array`, {
      context: { postId36 },
    });
  }
  return children;
}
