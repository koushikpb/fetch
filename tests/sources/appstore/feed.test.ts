// Unit tests for sources/appstore/feed.ts's wire-format parsing, in isolation from
// adapter.ts's fan-out/pagination/cursor concerns (covered separately in adapter.test.ts).
// Fixtures under tests/fixtures/appstore/ are real responses captured live from
// itunes.apple.com on 2026-08-05 (see each fixture's provenance below) — SPEC I-03's
// "no XML parser dependency is authorized ... verify what the endpoint actually returns"
// resolution, satisfied by capturing rather than assuming the shape.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { UpstreamError } from '../../../lib/errors.js';
import {
  MAX_PAGES,
  buildFeedUrl,
  buildReviewsPageUrl,
  parseFeedEntries,
  parseReviewEntry,
} from '../../../sources/appstore/feed.js';

const FIXTURES_DIR = new URL('../../fixtures/appstore/', import.meta.url);

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(name, FIXTURES_DIR), 'utf8'));
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    // The real endpoint serves `text/javascript`, not `application/json` (verified live) —
    // included here so a test regresses if parseFeedEntries were ever changed to gate on it.
    headers: { 'content-type': 'text/javascript; charset=UTF-8' },
  });
}

describe('MAX_PAGES', () => {
  it('is 10, matching the feed\'s verified 500-review ceiling (10 pages x 50 reviews)', () => {
    expect(MAX_PAGES).toBe(10);
  });
});

describe('buildFeedUrl', () => {
  it('omits the page segment for page 1', () => {
    // Verified live (2026-08-05): an explicit "page=1" segment returns an empty feed even
    // when the equivalent no-page request for the identical app succeeds — so page 1
    // deliberately never gets an explicit segment.
    expect(buildFeedUrl('123', 'us', 1)).toBe(
      'https://itunes.apple.com/us/rss/customerreviews/id=123/sortby=mostrecent/json',
    );
  });

  it('inserts page=<n> before id= for page > 1', () => {
    expect(buildFeedUrl('123', 'gb', 3)).toBe(
      'https://itunes.apple.com/gb/rss/customerreviews/page=3/id=123/sortby=mostrecent/json',
    );
  });
});

describe('buildReviewsPageUrl', () => {
  it('builds the human-visitable App Store reviews URL for a pair', () => {
    // Every review entry's own `link` field points at this same app-level URL (verified
    // live) rather than a per-review deep link, so this is the most specific traceable
    // evidence URL this feed makes available (CLAUDE.md global rule 1).
    expect(buildReviewsPageUrl({ appId: '123', territory: 'us' })).toBe(
      'https://apps.apple.com/us/app/id123?see-all=reviews',
    );
  });
});

describe('parseFeedEntries', () => {
  it('returns [] for a real empty feed (an app ID with no reviews)', async () => {
    // Captured live: https://itunes.apple.com/us/rss/customerreviews/id=999999999999/sortby=mostrecent/json
    const entries = await parseFeedEntries(jsonResponse(loadFixture('empty-feed.json')), 'https://example.test/x');
    expect(entries).toEqual([]);
  });

  it('normalizes a single-entry feed into a one-element array', async () => {
    // Captured live: https://itunes.apple.com/gb/rss/customerreviews/id=6740220635/sortby=mostrecent/json
    // — a real app with exactly one written review. Proves the Atom-to-JSON transliteration
    // quirk: a single-element `entry` list is a bare object in the JSON, not a one-element
    // array, so `parseFeedEntries` must normalize both shapes.
    const entries = await parseFeedEntries(jsonResponse(loadFixture('single-entry.json')), 'https://example.test/x');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ id: { label: '14281590861' } });
  });

  it('returns every entry in a real multi-entry feed as an array, unmodified', async () => {
    // Captured live from Yelp's US review feed (id=284910350), trimmed to one real entry per
    // star rating (1-5) — see the fixture file header for provenance.
    const entries = await parseFeedEntries(
      jsonResponse(loadFixture('page1-mixed-ratings.json')),
      'https://example.test/x',
    );
    expect(entries).toHaveLength(5);
  });

  it('throws UpstreamError when the response body is not valid JSON', async () => {
    const response = new Response('<html>not json</html>', { status: 200 });
    await expect(parseFeedEntries(response, 'https://example.test/x')).rejects.toThrow(UpstreamError);
  });

  it('throws UpstreamError when the top-level "feed" envelope is missing', async () => {
    await expect(parseFeedEntries(jsonResponse({ notFeed: true }), 'https://example.test/x')).rejects.toThrow(
      UpstreamError,
    );
  });
});

describe('parseReviewEntry', () => {
  const pair = { appId: '284910350', territory: 'us' };

  it('maps a real review entry into a Document, with rating as a number in engagement', async () => {
    const entries = await parseFeedEntries(
      jsonResponse(loadFixture('page1-mixed-ratings.json')),
      'https://example.test/x',
    );
    const fiveStarEntry = entries[0];
    const parsed = parseReviewEntry(fiveStarEntry, pair);

    expect(parsed).toBeDefined();
    expect(parsed?.document.source).toBe('appstore');
    expect(parsed?.document.sourceId).toBe('14385228506');
    expect(parsed?.document.url).toBe('https://apps.apple.com/us/app/id284910350?see-all=reviews');
    expect(parsed?.document.title).toBe('Yelp');
    expect(parsed?.document.body).toBe('Excellent resource for information.');
    expect(parsed?.document.authorHandle).toBe('Devkika');
    expect(parsed?.document.createdAt).toBeInstanceOf(Date);
    // Criterion 2's real content: rating is a `number`, not a string, and lives in
    // `engagement` (X-02's prefilter reads it from there), not only inside `raw`.
    expect(parsed?.document.engagement.rating).toBe(5);
    expect(typeof parsed?.document.engagement.rating).toBe('number');
    // `raw` is the untouched entry, not reviewEntrySchema's narrowed parse output — proven by
    // deep-equality against the exact fixture entry, which carries fields (im:version,
    // im:contentType, the author's `uri`) that reviewEntrySchema never declares.
    expect(parsed?.document.raw).toEqual(fiveStarEntry);
  });

  it('preserves a one-star rating end to end (the densest-signal case criterion 2 exists for)', async () => {
    const entries = await parseFeedEntries(
      jsonResponse(loadFixture('page1-mixed-ratings.json')),
      'https://example.test/x',
    );
    const oneStarEntry = entries.find(
      (entry) => (entry as { 'im:rating': { label: string } })['im:rating'].label === '1',
    );
    const parsed = parseReviewEntry(oneStarEntry, pair);
    expect(parsed?.document.engagement.rating).toBe(1);
  });

  it('preserves a two-star rating end to end', async () => {
    const entries = await parseFeedEntries(
      jsonResponse(loadFixture('page1-mixed-ratings.json')),
      'https://example.test/x',
    );
    const twoStarEntry = entries.find(
      (entry) => (entry as { 'im:rating': { label: string } })['im:rating'].label === '2',
    );
    const parsed = parseReviewEntry(twoStarEntry, pair);
    expect(parsed?.document.engagement.rating).toBe(2);
  });

  it('returns undefined, without throwing, for an entry missing im:rating', () => {
    const malformed = {
      id: { label: '1' },
      author: { name: { label: 'x' } },
      updated: { label: '2024-01-01T00:00:00Z' },
      content: { label: 'x' },
    };
    expect(parseReviewEntry(malformed, pair)).toBeUndefined();
  });

  it('returns undefined for a rating outside 1-5', () => {
    const malformed = {
      id: { label: '1' },
      author: { name: { label: 'x' } },
      updated: { label: '2024-01-01T00:00:00Z' },
      content: { label: 'x' },
      'im:rating': { label: '7' },
    };
    expect(parseReviewEntry(malformed, pair)).toBeUndefined();
  });

  it('returns undefined for a non-numeric rating value', () => {
    const malformed = {
      id: { label: '1' },
      author: { name: { label: 'x' } },
      updated: { label: '2024-01-01T00:00:00Z' },
      content: { label: 'x' },
      'im:rating': { label: 'five' },
    };
    expect(parseReviewEntry(malformed, pair)).toBeUndefined();
  });

  it('returns undefined for an unparseable timestamp', () => {
    const malformed = {
      id: { label: '1' },
      author: { name: { label: 'x' } },
      updated: { label: 'not-a-date' },
      content: { label: 'x' },
      'im:rating': { label: '5' },
    };
    expect(parseReviewEntry(malformed, pair)).toBeUndefined();
  });

  it('returns undefined for a non-object entry (e.g. the array-normalization ever misfires)', () => {
    expect(parseReviewEntry('not-an-object', pair)).toBeUndefined();
    expect(parseReviewEntry(null, pair)).toBeUndefined();
    expect(parseReviewEntry(['array', 'not', 'object'], pair)).toBeUndefined();
  });

  it('maps an empty author name and an absent title to null, not empty string', () => {
    const entry = {
      id: { label: '1' },
      author: { name: { label: '' } },
      updated: { label: '2024-01-01T00:00:00Z' },
      content: { label: 'body text' },
      'im:rating': { label: '3' },
    };
    const parsed = parseReviewEntry(entry, pair);
    expect(parsed?.document.authorHandle).toBeNull();
    expect(parsed?.document.title).toBeNull();
  });

  it('defaults voteCount/voteSum to 0 when the feed omits them', () => {
    const entry = {
      id: { label: '1' },
      author: { name: { label: 'x' } },
      updated: { label: '2024-01-01T00:00:00Z' },
      title: { label: 't' },
      content: { label: 'body text' },
      'im:rating': { label: '3' },
    };
    const parsed = parseReviewEntry(entry, pair);
    expect(parsed?.document.engagement).toMatchObject({ voteCount: 0, voteSum: 0 });
  });
});
