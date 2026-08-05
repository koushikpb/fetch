import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { UpstreamError } from '../../../lib/errors.js';
import {
  normalizeAuthor,
  parseCommentsResponse,
  parseListingResponse,
  toCommentDocument,
  toPostDocument,
  walkCommentTree,
} from '../../../sources/reddit/mapping.js';

const FIXTURES_DIR = path.join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'fixtures', 'reddit');

function loadFixture(file: string): unknown {
  return JSON.parse(readFileSync(path.join(FIXTURES_DIR, file), 'utf-8'));
}

describe('normalizeAuthor', () => {
  it('prefixes a real username with u/', () => {
    expect(normalizeAuthor('three_banks_no_luck')).toBe('u/three_banks_no_luck');
  });

  it('collapses the literal "[deleted]" to null rather than storing it', () => {
    expect(normalizeAuthor('[deleted]')).toBeNull();
  });

  it('collapses a blank or non-string author to null', () => {
    expect(normalizeAuthor('')).toBeNull();
    expect(normalizeAuthor(undefined)).toBeNull();
    expect(normalizeAuthor(null)).toBeNull();
    expect(normalizeAuthor(42)).toBeNull();
  });
});

describe('parseListingResponse', () => {
  it('unwraps a real Listing fixture into children + after', () => {
    const { children, after } = parseListingResponse(loadFixture('listing-new-page1.json'), 'testsub');
    expect(children).toHaveLength(2);
    expect(after).toBe('t3_bbb222');
  });

  it('reports after as null when the listing is exhausted', () => {
    const { after } = parseListingResponse(loadFixture('listing-new-page2.json'), 'testsub');
    expect(after).toBeNull();
  });

  it('throws UpstreamError on a response missing the Listing shape entirely', () => {
    expect(() => parseListingResponse({ not: 'a listing' }, 'testsub')).toThrow(UpstreamError);
    expect(() => parseListingResponse(null, 'testsub')).toThrow(UpstreamError);
    expect(() => parseListingResponse('a string', 'testsub')).toThrow(UpstreamError);
  });
});

describe('toPostDocument', () => {
  const { children } = parseListingResponse(loadFixture('listing-new-page1.json'), 'testsub');

  it('maps every required Document field', () => {
    const mapped = toPostDocument(children[0]!);
    expect(mapped).toBeDefined();
    expect(mapped?.document).toEqual({
      source: 'reddit',
      sourceId: 't3_aaa111',
      url: 'https://www.reddit.com/r/testsub/comments/aaa111/anyone_found_a_decent_multibank_subscription/',
      authorHandle: 'u/three_banks_no_luck',
      title: 'Anyone found a decent multi-bank subscription tracker?',
      body: "I've tried three apps and none of them handle more than one primary bank account well.",
      createdAt: new Date(1736460600 * 1000),
      engagement: { score: 340, numComments: 3, upvoteRatio: 0.94 },
      raw: children[0],
    });
    expect(mapped?.postId36).toBe('aaa111');
    expect(mapped?.permalink).toBe('/r/testsub/comments/aaa111/anyone_found_a_decent_multibank_subscription/');
    expect(mapped?.numComments).toBe(3);
  });

  it('normalizes a deleted author to null and keeps an empty selftext as an empty body', () => {
    const mapped = toPostDocument(children[1]!);
    expect(mapped?.document.authorHandle).toBeNull();
    expect(mapped?.document.body).toBe('');
  });

  it('returns undefined (does not throw) for a child missing a required field', () => {
    expect(toPostDocument({ id: 'x', name: 't3_x' })).toBeUndefined();
  });
});

describe('toCommentDocument', () => {
  it('maps a comment and falls back to a permalink derived from the post when absent', () => {
    const mapped = toCommentDocument(
      {
        id: 'cm1',
        name: 't1_cm1',
        author: 'spreadsheet_survivor',
        body: 'Gave up and built my own spreadsheet.',
        created_utc: 1736461000,
        score: 89,
      },
      '/r/testsub/comments/aaa111/anyone_found_a_decent_multibank_subscription/',
    );
    expect(mapped?.document).toEqual({
      source: 'reddit',
      sourceId: 't1_cm1',
      url: 'https://www.reddit.com/r/testsub/comments/aaa111/anyone_found_a_decent_multibank_subscription/cm1/',
      authorHandle: 'u/spreadsheet_survivor',
      title: null,
      body: 'Gave up and built my own spreadsheet.',
      createdAt: new Date(1736461000 * 1000),
      engagement: { score: 89 },
      raw: { id: 'cm1', name: 't1_cm1', author: 'spreadsheet_survivor', body: 'Gave up and built my own spreadsheet.', created_utc: 1736461000, score: 89 },
    });
  });

  it('uses Reddit-supplied permalink when present, and excludes replies from raw', () => {
    const mapped = toCommentDocument(
      {
        id: 'cm2',
        name: 't1_cm2',
        author: 'someone',
        body: 'body text',
        created_utc: 1736461000,
        score: 1,
        permalink: '/r/testsub/comments/aaa111/title/cm2/',
        replies: { kind: 'Listing', data: { children: [{ kind: 't1', data: { id: 'nested' } }] } },
      },
      '/r/testsub/comments/aaa111/title/',
    );
    expect(mapped?.document.url).toBe('https://www.reddit.com/r/testsub/comments/aaa111/title/cm2/');
    expect(mapped?.document.raw).not.toHaveProperty('replies');
    expect(mapped?.repliesNode).toEqual({ kind: 'Listing', data: { children: [{ kind: 't1', data: { id: 'nested' } }] } });
  });

  it('returns undefined for a comment missing a required field', () => {
    expect(toCommentDocument({ id: 'x' }, '/permalink/')).toBeUndefined();
  });
});

describe('walkCommentTree — bounded depth and breadth (composer resolution 5)', () => {
  it('takes at most maxBreadth top-level comments, skips "more" stubs, and stops recursing past maxDepth', () => {
    const [, commentsListing] = loadFixture('comments-aaa111.json') as [unknown, { data: { children: unknown[] } }];
    const documents = walkCommentTree(commentsListing.data.children, '/r/testsub/x/', 2, 5);

    const sourceIds = documents.map((d) => d.sourceId);
    // Breadth: exactly 5 top-level comments taken (cm1, c2..c5); c6/c7/the "more" stub excluded.
    expect(sourceIds).toContain('t1_cm1');
    expect(sourceIds).toContain('t1_c2');
    expect(sourceIds).toContain('t1_c3');
    expect(sourceIds).toContain('t1_c4');
    expect(sourceIds).toContain('t1_c5');
    expect(sourceIds).not.toContain('t1_c6');
    expect(sourceIds).not.toContain('t1_c7');

    // Depth: cm1's direct reply (depth 1) is included; that reply's own reply (depth 2) is
    // not, since maxDepth=2 only covers depths 0 and 1.
    expect(sourceIds).toContain('t1_cm1a');
    expect(sourceIds).not.toContain('t1_cm1a1');

    expect(documents).toHaveLength(6);
  });

  it('returns nothing at depth >= maxDepth without making any further request', () => {
    const [, commentsListing] = loadFixture('comments-aaa111.json') as [unknown, { data: { children: unknown[] } }];
    expect(walkCommentTree(commentsListing.data.children, '/r/testsub/x/', 0, 5)).toEqual([]);
  });
});

describe('parseCommentsResponse', () => {
  it('unwraps the second Listing element of a real fixture', () => {
    const children = parseCommentsResponse(loadFixture('comments-ccc333.json'), 'ccc333');
    expect(children).toHaveLength(2);
  });

  it('throws UpstreamError when the response is not a two-element array', () => {
    expect(() => parseCommentsResponse({ not: 'an array' }, 'x')).toThrow(UpstreamError);
    expect(() => parseCommentsResponse([{}], 'x')).toThrow(UpstreamError);
  });

  it('throws UpstreamError when the second element has no children array', () => {
    expect(() => parseCommentsResponse([{}, { data: {} }], 'x')).toThrow(UpstreamError);
  });
});
