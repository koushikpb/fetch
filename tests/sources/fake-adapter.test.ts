// SPEC I-01 criterion 4 and composer resolution 6: the fake adapter is a first-class
// deliverable I-02/I-03/I-04's own adapter tests and I-05's orchestrator tests will build
// on. Every scenario resolution 6 lists gets its own test below: returning documents,
// returning nothing, advancing a cursor, exhausting a cursor, reporting unhealthy, and
// throwing on fetch.
import { describe, expect, it } from 'vitest';
import { NetworkError } from '../../lib/errors.js';
import type { Document } from '../../lib/types.js';
import { createFakeAdapter } from '../../sources/fake-adapter.js';

const DOC_1: Document = {
  source: 'hackernews',
  sourceId: 'doc-1',
  url: 'https://example.com/1',
  authorHandle: 'alice',
  title: 'first',
  body: 'first body',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  engagement: { points: 1 },
  raw: {},
};

const DOC_2: Document = {
  ...DOC_1,
  sourceId: 'doc-2',
  url: 'https://example.com/2',
  title: 'second',
  body: 'second body',
};

const DOC_3: Document = {
  ...DOC_1,
  sourceId: 'doc-3',
  url: 'https://example.com/3',
  title: 'third',
  body: 'third body',
};

describe('createFakeAdapter — the no-op default (SPEC I-01 criterion 4)', () => {
  it('is healthy, returns no documents, and never advances the cursor with no configuration at all', async () => {
    const fake = createFakeAdapter();
    const health = await fake.checkHealth();
    expect(health).toEqual({ healthy: true, detail: expect.any(String) });

    const incremental = await fake.fetchIncremental(undefined);
    expect(incremental).toEqual({ documents: [], cursor: undefined });

    const backfill = await fake.fetchBackfill(
      { since: new Date('2026-01-01T00:00:00.000Z'), until: new Date('2026-02-01T00:00:00.000Z') },
      undefined,
    );
    expect(backfill).toEqual({ documents: [], cursor: undefined });
  });

  it('defaults source to hackernews', () => {
    expect(createFakeAdapter().source).toBe('hackernews');
  });

  it('honors an explicit source', () => {
    expect(createFakeAdapter({ source: 'reddit' }).source).toBe('reddit');
  });
});

describe('createFakeAdapter — returning documents, advancing and exhausting a cursor', () => {
  it('returns the first configured page on the first call (cursor undefined)', async () => {
    const fake = createFakeAdapter({ pages: [[DOC_1, DOC_2], [DOC_3]] });
    const page = await fake.fetchIncremental(undefined);
    expect(page.documents).toEqual([DOC_1, DOC_2]);
    expect(page.cursor).toBeDefined();
  });

  it('advances to the next page when handed back the previous cursor', async () => {
    const fake = createFakeAdapter({ pages: [[DOC_1], [DOC_2], [DOC_3]] });
    const page1 = await fake.fetchIncremental(undefined);
    const page2 = await fake.fetchIncremental(page1.cursor);
    const page3 = await fake.fetchIncremental(page2.cursor);
    expect(page1.documents).toEqual([DOC_1]);
    expect(page2.documents).toEqual([DOC_2]);
    expect(page3.documents).toEqual([DOC_3]);
  });

  it('returns cursor undefined once the configured pages are exhausted', async () => {
    const fake = createFakeAdapter({ pages: [[DOC_1]] });
    const page1 = await fake.fetchIncremental(undefined);
    expect(page1.cursor).toBeUndefined();
  });

  it('calling with an exhausted cursor again deterministically returns nothing further', async () => {
    const fake = createFakeAdapter({ pages: [[DOC_1]] });
    const page1 = await fake.fetchIncremental(undefined);
    // Re-run semantics (I-05 criterion: "re-running immediately inserts zero new rows") —
    // the fake must replay "nothing new" for the same terminal cursor, not silently produce
    // more documents just because it was called again.
    const page2 = await fake.fetchIncremental(page1.cursor ?? 'unreachable');
    expect(page1.documents).toEqual([DOC_1]);
    expect(page2).toEqual({ documents: [], cursor: undefined });
  });

  it('replaying an earlier cursor deterministically returns that same page again, not the next one', async () => {
    // Proves pagination is driven by the cursor value itself, not a hidden internal call
    // counter — calling fetchIncremental(undefined) twice in a row must return the same
    // first page both times, exactly like a real orchestrator restarting from scratch would
    // need it to.
    const fake = createFakeAdapter({ pages: [[DOC_1], [DOC_2]] });
    const first = await fake.fetchIncremental(undefined);
    const again = await fake.fetchIncremental(undefined);
    expect(first).toEqual(again);
  });

  it('"returning nothing" — an empty page is a valid configured page, not just the tail state', async () => {
    const fake = createFakeAdapter({ pages: [[]] });
    const page = await fake.fetchIncremental(undefined);
    expect(page).toEqual({ documents: [], cursor: undefined });
  });

  it('backfill pagination is independent of incremental pagination', async () => {
    const fake = createFakeAdapter({
      pages: [[DOC_1]],
      backfillPages: [[DOC_2], [DOC_3]],
    });
    const range = {
      since: new Date('2025-01-01T00:00:00.000Z'),
      until: new Date('2025-06-01T00:00:00.000Z'),
    };
    const incremental = await fake.fetchIncremental(undefined);
    const backfill1 = await fake.fetchBackfill(range, undefined);
    const backfill2 = await fake.fetchBackfill(range, backfill1.cursor);
    expect(incremental.documents).toEqual([DOC_1]);
    expect(backfill1.documents).toEqual([DOC_2]);
    expect(backfill2.documents).toEqual([DOC_3]);
  });

  it('fake.setPages replaces the page sequence and resets pagination to the first page', async () => {
    const fake = createFakeAdapter({ pages: [[DOC_1]] });
    await fake.fetchIncremental(undefined);
    fake.fake.setPages([[DOC_2, DOC_3]]);
    const page = await fake.fetchIncremental(undefined);
    expect(page.documents).toEqual([DOC_2, DOC_3]);
  });
});

describe('createFakeAdapter — reporting unhealthy', () => {
  it('reports unhealthy when configured at creation', async () => {
    const fake = createFakeAdapter({ health: { healthy: false, detail: 'upstream is down' } });
    await expect(fake.checkHealth()).resolves.toEqual({
      healthy: false,
      detail: 'upstream is down',
    });
  });

  it('fake.setHealth changes the reported status without throwing', async () => {
    const fake = createFakeAdapter();
    await expect(fake.checkHealth()).resolves.toMatchObject({ healthy: true });
    fake.fake.setHealth({ healthy: false, detail: 'now unreachable' });
    await expect(fake.checkHealth()).resolves.toEqual({
      healthy: false,
      detail: 'now unreachable',
    });
  });
});

describe('createFakeAdapter — throwing on fetch', () => {
  it('fetchIncremental rejects with the configured error', async () => {
    const err = new NetworkError('simulated upstream failure');
    const fake = createFakeAdapter({ fetchError: err });
    await expect(fake.fetchIncremental(undefined)).rejects.toBe(err);
  });

  it('fetchBackfill rejects with the configured error', async () => {
    const err = new NetworkError('simulated upstream failure');
    const fake = createFakeAdapter({ fetchError: err });
    const range = {
      since: new Date('2025-01-01T00:00:00.000Z'),
      until: new Date('2025-02-01T00:00:00.000Z'),
    };
    await expect(fake.fetchBackfill(range, undefined)).rejects.toBe(err);
  });

  it('checkHealth never throws even when a fetch error is configured — health is data, not an exception', async () => {
    const fake = createFakeAdapter({ fetchError: new NetworkError('simulated upstream failure') });
    await expect(fake.checkHealth()).resolves.toEqual({
      healthy: true,
      detail: expect.any(String),
    });
  });

  it('fake.setFetchError(undefined) clears a configured failure — later fetches succeed again', async () => {
    const fake = createFakeAdapter({ pages: [[DOC_1]], fetchError: new NetworkError('down') });
    await expect(fake.fetchIncremental(undefined)).rejects.toThrow('down');
    fake.fake.setFetchError(undefined);
    await expect(fake.fetchIncremental(undefined)).resolves.toEqual({
      documents: [DOC_1],
      cursor: undefined,
    });
  });
});

describe('createFakeAdapter — call counters', () => {
  it('counts fetchIncremental, fetchBackfill, and checkHealth calls independently', async () => {
    const fake = createFakeAdapter({ pages: [[DOC_1], [DOC_2]], backfillPages: [[DOC_3]] });
    expect(fake.fake.incrementalCallCount()).toBe(0);
    expect(fake.fake.backfillCallCount()).toBe(0);
    expect(fake.fake.healthCallCount()).toBe(0);

    await fake.fetchIncremental(undefined);
    await fake.fetchIncremental('1');
    await fake.fetchBackfill(
      { since: new Date('2025-01-01T00:00:00.000Z'), until: new Date('2025-02-01T00:00:00.000Z') },
      undefined,
    );
    await fake.checkHealth();

    expect(fake.fake.incrementalCallCount()).toBe(2);
    expect(fake.fake.backfillCallCount()).toBe(1);
    expect(fake.fake.healthCallCount()).toBe(1);
  });

  it('still counts an attempt that goes on to throw', async () => {
    const fake = createFakeAdapter({ fetchError: new NetworkError('down') });
    await expect(fake.fetchIncremental(undefined)).rejects.toThrow();
    expect(fake.fake.incrementalCallCount()).toBe(1);
  });
});
