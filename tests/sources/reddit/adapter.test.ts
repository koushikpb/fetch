import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createNetClient, type NetClient, type Transport } from '../../../lib/net.js';
import { ConfigError, NetworkError, RateLimitError, UpstreamError } from '../../../lib/errors.js';
import { createRedditAdapter } from '../../../sources/reddit/adapter.js';
import type { RedditFetchPage } from '../../../sources/reddit/types.js';
import { createFakeRedditServer, type Router } from './support/fake-reddit-server.js';

const FIXTURES_DIR = path.join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'fixtures', 'reddit');
const TOKEN_URL = 'https://fake-reddit-auth.test/token';

// Every file under tests/fixtures/reddit/ is hand-authored, not captured from Reddit — see
// that directory's README.md for the recording attempt that failed and what it leaves open.
function loadFixture(file: string): unknown {
  return JSON.parse(readFileSync(path.join(FIXTURES_DIR, file), 'utf-8'));
}

// Retries never actually fire in the happy-path tests below — 200/401/403/404 all return
// immediately per lib/net.ts's own contract — but the partial-outcome tests deliberately
// trigger a 5xx and a 429, so every adapter test uses a single attempt and a no-op sleep
// uniformly, the same way tests/net.test.ts's own `recordSleeps()` keeps retry-bearing tests
// fast.
function fastNetClient(transport: Transport): NetClient {
  return createNetClient({ transport, sleep: async () => undefined, retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 } });
}

const AUTH = { clientId: 'client-id-1', clientSecret: 'super-secret-value', userAgent: 'fetch-app/0.1 (by /u/test)', tokenUrl: TOKEN_URL };

function captureStdoutWrites(): { lines: () => string[]; restore: () => void } {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  });
  return { lines: () => chunks, restore: () => spy.mockRestore() };
}

interface StubPost {
  readonly id: string;
  readonly numComments: number;
}

function listingWith(subreddit: string, posts: readonly StubPost[], after: string | null): unknown {
  return {
    kind: 'Listing',
    data: {
      after,
      before: null,
      dist: posts.length,
      children: posts.map((post) => ({
        kind: 't3',
        data: {
          id: post.id,
          name: `t3_${post.id}`,
          title: `post ${post.id}`,
          selftext: 'body',
          author: `author_${post.id}`,
          created_utc: 1740000000,
          score: 1,
          num_comments: post.numComments,
          upvote_ratio: 0.9,
          subreddit,
          permalink: `/r/${subreddit}/comments/${post.id}/post_${post.id}/`,
        },
      })),
    },
  };
}

function commentsWith(postName: string, commentIds: readonly string[]): unknown {
  return [
    { kind: 'Listing', data: { children: [{ kind: 't3', data: { id: postName.slice(3), name: postName } }] } },
    {
      kind: 'Listing',
      data: {
        children: commentIds.map((commentId) => ({
          kind: 't1',
          data: {
            id: commentId,
            name: `t1_${commentId}`,
            author: `commenter_${commentId}`,
            body: 'a reply',
            created_utc: 1740000100,
            score: 1,
            parent_id: postName,
            link_id: postName,
            replies: '',
          },
        })),
      },
    },
  ];
}

function findLogRecord(capturedStdout: string, msg: string): Record<string, unknown> | undefined {
  return capturedStdout
    .split('\n')
    .filter((line) => line.startsWith('{') && line.endsWith('}'))
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .find((record) => record.msg === msg);
}

function dataUrls(server: { calls: () => readonly { url: string }[] }): string[] {
  return server.calls().map((call) => call.url).filter((url) => url !== TOKEN_URL);
}

describe('createRedditAdapter — no subreddits configured (conservative default)', () => {
  it('reports itself exhausted immediately, with no network call at all', async () => {
    const adapter = createRedditAdapter();
    const page = await adapter.fetchIncremental(undefined);
    expect(page).toEqual({ documents: [], cursor: undefined });
  });

  it('source is "reddit"', () => {
    expect(createRedditAdapter().source).toBe('reddit');
  });
});

describe('createRedditAdapter — no OAuth credentials configured', () => {
  it('fetchIncremental throws ConfigError once subreddits are configured but auth is not', async () => {
    const adapter = createRedditAdapter({ subreddits: ['testsub'] });
    await expect(adapter.fetchIncremental(undefined)).rejects.toThrow(ConfigError);
  });

  it('checkHealth reports unhealthy without attempting any network call', async () => {
    const adapter = createRedditAdapter();
    const health = await adapter.checkHealth();
    expect(health.healthy).toBe(false);
    expect(health.detail).toContain('no OAuth credentials');
  });
});

describe('integration: fetchIncremental against hand-authored Reddit-shaped fixtures (criterion 5)', () => {
  const route: Router = (url) => {
    if (url.pathname === '/r/testsub/new') {
      const after = url.searchParams.get('after');
      return { body: loadFixture(after === null ? 'synthetic-listing-new-page1.json' : 'synthetic-listing-new-page2.json') };
    }
    if (url.pathname === '/r/testsub/top') {
      return { body: loadFixture('synthetic-listing-top-page1.json') };
    }
    if (url.pathname === '/r/testsub/comments/aaa111') {
      return { body: loadFixture('synthetic-comments-aaa111.json') };
    }
    if (url.pathname === '/r/testsub/comments/ccc333') {
      return { body: loadFixture('synthetic-comments-ccc333.json') };
    }
    return undefined;
  };

  function buildAdapter() {
    const server = createFakeRedditServer({ tokenUrl: TOKEN_URL, route });
    const adapter = createRedditAdapter({ ...AUTH, subreddits: ['testsub'], netClient: fastNetClient(server.transport) });
    return { server, adapter };
  }

  it('walks new (2 pages) then top (1 page), expanding only qualifying threads, until genuinely exhausted', async () => {
    const { adapter } = buildAdapter();

    const page1 = (await adapter.fetchIncremental(undefined)) as RedditFetchPage;
    // aaa111 (6 comments) qualifies and expands to 6 bounded comment Documents (see
    // mapping.test.ts for the depth/breadth math); bbb222 (0 comments) does not — if the
    // adapter mistakenly requested its thread, the fake server would throw on the
    // unrouted URL and fail this test loudly.
    expect(page1.documents).toHaveLength(2 + 6);
    expect(page1.documents.map((d) => d.sourceId)).toEqual(
      expect.arrayContaining(['t3_aaa111', 't3_bbb222', 't1_cm1', 't1_c2', 't1_c3', 't1_c4', 't1_c5']),
    );
    expect(page1.cursor).toBe(JSON.stringify({ subreddit: 'testsub', listing: 'new', after: 't3_bbb222' }));
    expect(page1.outcome).toBeUndefined();
    expect(page1.rateLimitHeadroom).toEqual({ remaining: 99, used: 1, resetSeconds: 580 });

    const page2 = (await adapter.fetchIncremental(page1.cursor)) as RedditFetchPage;
    expect(page2.documents).toHaveLength(1 + 2);
    expect(page2.documents.map((d) => d.sourceId)).toEqual(expect.arrayContaining(['t3_ccc333', 't1_ce1', 't1_ce2']));
    expect(page2.cursor).toBe(JSON.stringify({ subreddit: 'testsub', listing: 'top', after: null }));

    const page3 = (await adapter.fetchIncremental(page2.cursor)) as RedditFetchPage;
    expect(page3.documents).toHaveLength(1);
    expect(page3.documents[0]?.sourceId).toBe('t3_ddd444');
    expect(page3.cursor).toBeUndefined();
  });

  it('keeps the whole untouched post node in raw, including the dozens of fields it never reads', async () => {
    const { adapter } = buildAdapter();

    const page = (await adapter.fetchIncremental(undefined)) as RedditFetchPage;
    const post = page.documents.find((d) => d.sourceId === 't3_aaa111');
    const raw = post?.raw as Record<string, unknown>;

    expect(raw.subreddit_id).toBe('t5_2qh0k');
    expect(raw.author_fullname).toBe('t2_placeholder01');
    expect(raw.link_flair_text).toBe('Question');
    expect(raw.stickied).toBe(false);
    expect(raw.num_crossposts).toBe(0);
  });

  it("sends Reddit's own limit/raw_json/depth/sort query params, not just this adapter's internal defaults", async () => {
    const { server, adapter } = buildAdapter();

    await adapter.fetchIncremental(undefined);

    const calls = server.calls();
    expect(calls.some((c) => c.url === 'https://oauth.reddit.com/r/testsub/new?limit=25&raw_json=1')).toBe(true);
    expect(
      calls.some((c) => c.url === 'https://oauth.reddit.com/r/testsub/comments/aaa111?limit=5&depth=2&sort=top&raw_json=1'),
    ).toBe(true);
  });

  it('never sends the client secret in any request — the access token is sent by design, the secret never is', async () => {
    const { server, adapter } = buildAdapter();
    await adapter.fetchIncremental(undefined);

    for (const call of server.calls()) {
      if (call.url === TOKEN_URL) {
        continue;
      }
      expect(JSON.stringify(call.init.headers)).not.toContain(AUTH.clientSecret);
    }
  });
});

describe('comment-expansion failure: one thread costs one thread, and the cursor does not move past the page', () => {
  const failingPost = '/r/partialtest/comments/fff666';

  function routeWith(failure: Response): Router {
    return (url) => {
      if (url.pathname === '/r/partialtest/new') {
        return { body: loadFixture('synthetic-listing-partial.json') };
      }
      if (url.pathname === '/r/partialtest/comments/eee555') {
        return { body: loadFixture('synthetic-comments-eee555.json') };
      }
      if (url.pathname === '/r/partialtest/comments/ggg777') {
        return { body: loadFixture('synthetic-comments-ggg777.json') };
      }
      if (url.pathname === failingPost) {
        return failure.clone();
      }
      return undefined;
    };
  }

  function buildAdapter(failure: Response) {
    const server = createFakeRedditServer({ tokenUrl: TOKEN_URL, route: routeWith(failure) });
    const adapter = createRedditAdapter({
      ...AUTH,
      subreddits: ['partialtest'],
      netClient: fastNetClient(server.transport),
    });
    return { server, adapter };
  }

  it('expands the posts after the failing one instead of abandoning the rest of the page', async () => {
    const { server, adapter } = buildAdapter(new Response(null, { status: 500 }));

    const page = (await adapter.fetchIncremental(undefined)) as RedditFetchPage;

    // ggg777 comes after the failing fff666 in the listing: its comment is the proof that a
    // single transient fault costs one thread, not every remaining thread on the page.
    const sourceIds = page.documents.map((d) => d.sourceId);
    expect(sourceIds).toEqual(['t3_eee555', 't3_fff666', 't3_ggg777', 't1_cf1', 't1_ch1']);
    expect(dataUrls(server).some((url) => url.includes('/comments/ggg777'))).toBe(true);

    expect(page.outcome?.kind).toBe('partial');
    if (page.outcome?.kind === 'partial') {
      expect(page.outcome.error).toBeInstanceOf(UpstreamError);
    }
  });

  it('returns the cursor that reproduces this same page, never one pointing past it', async () => {
    const { adapter } = buildAdapter(new Response(null, { status: 500 }));

    const page = (await adapter.fetchIncremental(undefined)) as RedditFetchPage;

    // The listing itself reported `after: null` — advancing on that would move to the next
    // (subreddit, listing) pair and leave fff666's comments unfetched forever, since nothing
    // revisits a page the cursor has passed.
    expect(page.cursor).toBe(JSON.stringify({ subreddit: 'partialtest', listing: 'new', after: null }));
    expect(page.cursor).not.toBeUndefined();
  });

  it('re-fetches the same listing when that cursor is replayed', async () => {
    const { server, adapter } = buildAdapter(new Response(null, { status: 500 }));

    const first = (await adapter.fetchIncremental(undefined)) as RedditFetchPage;
    await adapter.fetchIncremental(first.cursor);

    const listingRequests = dataUrls(server).filter((url) => url.includes('/r/partialtest/new'));
    expect(listingRequests).toEqual([
      'https://oauth.reddit.com/r/partialtest/new?limit=25&raw_json=1',
      'https://oauth.reddit.com/r/partialtest/new?limit=25&raw_json=1',
    ]);
  });

  it('stops expanding on a RateLimitError instead of continuing, since continuing only deepens the violation', async () => {
    const { server, adapter } = buildAdapter(new Response(null, { status: 429 }));

    const page = (await adapter.fetchIncremental(undefined)) as RedditFetchPage;

    expect(page.outcome?.kind).toBe('partial');
    if (page.outcome?.kind === 'partial') {
      expect(page.outcome.error).toBeInstanceOf(RateLimitError);
    }
    expect(dataUrls(server).some((url) => url.includes('/comments/ggg777'))).toBe(false);
    // Still not advanced: ggg777's comments were not fetched either.
    expect(page.cursor).toBe(JSON.stringify({ subreddit: 'partialtest', listing: 'new', after: null }));
  });

  it('omits rateLimitHeadroom entirely rather than setting it to undefined, on a partial page as on any other', async () => {
    // A raw Response from the route bypasses the fake server's default rate-limit headers,
    // so this page genuinely has no headroom to report.
    const route: Router = (url) => {
      if (url.pathname === '/r/partialtest/new') {
        return new Response(JSON.stringify(loadFixture('synthetic-listing-partial.json')), { status: 200 });
      }
      if (url.pathname === '/r/partialtest/comments/eee555' || url.pathname === '/r/partialtest/comments/ggg777') {
        return new Response(JSON.stringify(loadFixture('synthetic-comments-eee555.json')), { status: 200 });
      }
      return new Response(null, { status: 500 });
    };
    const server = createFakeRedditServer({ tokenUrl: TOKEN_URL, route });
    const adapter = createRedditAdapter({ ...AUTH, subreddits: ['partialtest'], netClient: fastNetClient(server.transport) });

    const page = (await adapter.fetchIncremental(undefined)) as RedditFetchPage;

    expect(page.outcome?.kind).toBe('partial');
    expect('rateLimitHeadroom' in page).toBe(false);
  });
});

describe('cursors are keyed on the subreddit name, not its position in the configured list', () => {
  const route: Router = (url) => {
    if (url.pathname === '/r/alpha/new' || url.pathname === '/r/alpha/top') {
      return { body: listingWith('alpha', [{ id: 'a1', numComments: 0 }], null) };
    }
    if (url.pathname === '/r/beta/new') {
      const after = url.searchParams.get('after');
      return { body: listingWith('beta', [{ id: after === null ? 'b1' : 'b2', numComments: 0 }], after === null ? 't3_bpage1' : null) };
    }
    if (url.pathname === '/r/beta/top') {
      return { body: listingWith('beta', [{ id: 'b3', numComments: 0 }], null) };
    }
    if (url.pathname === '/r/gamma/new' || url.pathname === '/r/gamma/top') {
      return { body: listingWith('gamma', [{ id: 'g1', numComments: 0 }], null) };
    }
    return undefined;
  };

  async function cursorPointingIntoBetaNew(): Promise<string> {
    const server = createFakeRedditServer({ tokenUrl: TOKEN_URL, route });
    const adapter = createRedditAdapter({ ...AUTH, subreddits: ['alpha', 'beta'], netClient: fastNetClient(server.transport) });
    // alpha/new -> alpha/top -> beta/new, which reports more pages available.
    let cursor = (await adapter.fetchIncremental(undefined)).cursor;
    cursor = (await adapter.fetchIncremental(cursor)).cursor;
    cursor = (await adapter.fetchIncremental(cursor)).cursor;
    expect(cursor).toBe(JSON.stringify({ subreddit: 'beta', listing: 'new', after: 't3_bpage1' }));
    if (cursor === undefined) {
      throw new Error('expected a cursor pointing partway into beta/new');
    }
    return cursor;
  }

  it('resumes the subreddit it was minted for after another entry is prepended to the list', async () => {
    const cursor = await cursorPointingIntoBetaNew();
    const server = createFakeRedditServer({ tokenUrl: TOKEN_URL, route });
    const adapter = createRedditAdapter({
      ...AUTH,
      subreddits: ['gamma', 'alpha', 'beta'],
      netClient: fastNetClient(server.transport),
    });

    const page = (await adapter.fetchIncremental(cursor)) as RedditFetchPage;

    // An index-keyed cursor would have resolved position 2 against the new list and issued
    // r/alpha/new?after=t3_bpage1 — a beta fullname against alpha's listing.
    expect(dataUrls(server)).toEqual(['https://oauth.reddit.com/r/beta/new?limit=25&raw_json=1&after=t3_bpage1']);
    expect(page.documents.map((d) => d.sourceId)).toEqual(['t3_b2']);
  });

  it('restarts the sweep, rather than throwing, when the subreddit it was minted for is removed', async () => {
    const cursor = await cursorPointingIntoBetaNew();
    const server = createFakeRedditServer({ tokenUrl: TOKEN_URL, route });
    const adapter = createRedditAdapter({ ...AUTH, subreddits: ['gamma'], netClient: fastNetClient(server.transport) });

    const page = (await adapter.fetchIncremental(cursor)) as RedditFetchPage;

    expect(dataUrls(server)).toEqual(['https://oauth.reddit.com/r/gamma/new?limit=25&raw_json=1']);
    expect(page.documents.map((d) => d.sourceId)).toEqual(['t3_g1']);
    expect(page.cursor).toBe(JSON.stringify({ subreddit: 'gamma', listing: 'top', after: null }));
  });

  it('does the same for a backfill cursor whose subreddit was removed', async () => {
    const backfillRoute: Router = (url) =>
      url.pathname === '/r/gamma/new' ? { body: listingWith('gamma', [{ id: 'g1', numComments: 0 }], null) } : undefined;
    const server = createFakeRedditServer({ tokenUrl: TOKEN_URL, route: backfillRoute });
    const adapter = createRedditAdapter({ ...AUTH, subreddits: ['gamma'], netClient: fastNetClient(server.transport) });

    const page = await adapter.fetchBackfill(
      { since: new Date('2020-01-01T00:00:00.000Z'), until: new Date('2030-01-01T00:00:00.000Z') },
      JSON.stringify({ subreddit: 'deleted-from-config', after: 't3_somewhere' }),
    );

    expect(dataUrls(server)).toEqual(['https://oauth.reddit.com/r/gamma/new?limit=25&raw_json=1']);
    expect(page.documents.map((d) => d.sourceId)).toEqual(['t3_g1']);
  });
});

describe('criterion 1: OAuth token refresh handled transparently — expiry mid-run does not fail the run', () => {
  const route: Router = (url) => {
    if (url.pathname === '/r/expireydemo/new') return { body: listingWith('expireydemo', [{ id: 'p1', numComments: 7 }], null) };
    if (url.pathname === '/r/expireydemo/top') return { body: listingWith('expireydemo', [{ id: 'p2', numComments: 7 }], null) };
    if (url.pathname === '/r/expireydemo/comments/p1') return { body: commentsWith('t3_p1', ['c1']) };
    if (url.pathname === '/r/expireydemo/comments/p2') return { body: commentsWith('t3_p2', ['c2']) };
    return undefined;
  };

  it('refreshes and continues when the token expires between two paginated fetchIncremental calls', async () => {
    // Exactly 2 successful data requests per token: the listing + its one qualifying
    // comment thread within the first fetchIncremental call consume the entire budget, so
    // the *third* data request — the second call's listing fetch — lands with an
    // already-expired token. This is composer resolution 2's scenario verbatim: "a token
    // expiring between two paginated requests must refresh and continue, not surface as an
    // error."
    const server = createFakeRedditServer({ tokenUrl: TOKEN_URL, route, tokenUsesBeforeExpiry: 2 });
    const adapter = createRedditAdapter({
      ...AUTH,
      subreddits: ['expireydemo'],
      netClient: fastNetClient(server.transport),
    });

    const page1 = (await adapter.fetchIncremental(undefined)) as RedditFetchPage;
    expect(page1.outcome).toBeUndefined();
    expect(page1.documents.map((d) => d.sourceId)).toEqual(['t3_p1', 't1_c1']);

    const page2 = (await adapter.fetchIncremental(page1.cursor)) as RedditFetchPage;
    expect(page2.outcome).toBeUndefined();
    expect(page2.documents.map((d) => d.sourceId)).toEqual(['t3_p2', 't1_c2']);
    expect(page2.cursor).toBeUndefined();

    // The whole point: this run completed successfully across the expiry, and it did so by
    // actually minting a second token, not by coincidence.
    expect(server.tokenMintCount()).toBe(2);
  });
});

describe('fetchBackfill — date-range filtering on the new listing', () => {
  const route: Router = (url) => {
    if (url.pathname === '/r/backfillsub/new') {
      return { body: loadFixture('synthetic-listing-backfill-page1.json') };
    }
    if (url.pathname === '/r/backfillsub/comments/postyinrange') {
      return { body: loadFixture('synthetic-comments-postyinrange.json') };
    }
    // A request for `after=t3_shouldnotbefetched` (or anything else) means the adapter
    // ignored `passedWindow` and kept paginating — deliberately unrouted so that bug
    // fails loudly instead of silently succeeding.
    return undefined;
  };
  const RANGE = { since: new Date('2025-06-01T00:00:00.000Z'), until: new Date('2025-06-30T23:59:59.999Z') };

  it('includes only posts within range, and stops paginating a subreddit once it pages past range.since', async () => {
    const server = createFakeRedditServer({ tokenUrl: TOKEN_URL, route });
    const adapter = createRedditAdapter({
      ...AUTH,
      subreddits: ['backfillsub'],
      netClient: fastNetClient(server.transport),
    });

    const page = (await adapter.fetchBackfill(RANGE, undefined)) as RedditFetchPage;

    const sourceIds = page.documents.map((d) => d.sourceId);
    expect(sourceIds).toEqual(expect.arrayContaining(['t3_postyinrange', 't1_cg1']));
    expect(sourceIds).not.toContain('t3_postxtoonew');
    expect(sourceIds).not.toContain('t3_postztooold');
    // Only one subreddit configured, and it is exhausted after this single page (having
    // paged past range.since) — nothing left to backfill.
    expect(page.cursor).toBeUndefined();
  });

  it('never reports the range exhausted when a thread on the page went unexpanded', async () => {
    const failingRoute: Router = (url) => {
      if (url.pathname === '/r/backfillsub/new') {
        return { body: loadFixture('synthetic-listing-backfill-page1.json') };
      }
      if (url.pathname === '/r/backfillsub/comments/postyinrange') {
        return new Response(null, { status: 503 });
      }
      return undefined;
    };
    const server = createFakeRedditServer({ tokenUrl: TOKEN_URL, route: failingRoute });
    const adapter = createRedditAdapter({
      ...AUTH,
      subreddits: ['backfillsub'],
      netClient: fastNetClient(server.transport),
    });

    const page = (await adapter.fetchBackfill(RANGE, undefined)) as RedditFetchPage;

    // `cursor: undefined` here would claim this historical range holds nothing further —
    // and a backfill range is swept once, so postyinrange's comments would be gone for good.
    expect(page.cursor).toBe(JSON.stringify({ subreddit: 'backfillsub', after: null }));
    expect(page.outcome?.kind).toBe('partial');
    expect(page.documents.map((d) => d.sourceId)).toEqual(['t3_postyinrange']);
  });
});

describe('a page nothing could be mapped from is not reported as a clean empty success', () => {
  const route: Router = (url) =>
    url.pathname === '/r/shapechange/new' ? { body: loadFixture('synthetic-listing-unmappable-children.json') } : undefined;

  it('reports truncated, with the skipped/total counts, when every item fails to map', async () => {
    const server = createFakeRedditServer({ tokenUrl: TOKEN_URL, route });
    const adapter = createRedditAdapter({ ...AUTH, subreddits: ['shapechange'], netClient: fastNetClient(server.transport) });

    const page = (await adapter.fetchIncremental(undefined)) as RedditFetchPage;

    expect(page.documents).toEqual([]);
    expect(page.outcome?.kind).toBe('truncated');
    if (page.outcome?.kind === 'truncated') {
      expect(page.outcome.reason).toContain('3 of 3');
      expect(page.outcome.reason).toContain('r/shapechange/new');
    }
  });

  it('logs the skipped and total counts so a renamed upstream field is visible in a run log', async () => {
    const server = createFakeRedditServer({ tokenUrl: TOKEN_URL, route });
    const adapter = createRedditAdapter({ ...AUTH, subreddits: ['shapechange'], netClient: fastNetClient(server.transport) });

    const capture = captureStdoutWrites();
    await adapter.fetchIncremental(undefined);
    const lines = capture.lines().join('\n');
    capture.restore();

    const warning = findLogRecord(lines, 'Reddit listing items could not be mapped to Documents');
    expect(warning).toMatchObject({ level: 'warn', source: 'reddit', subreddit: 'shapechange', skipped: 3, total: 3 });
  });
});

describe('a comments response nothing could be mapped from is not reported as a clean success', () => {
  const route: Router = (url) => {
    if (url.pathname === '/r/commentshape/new') {
      return { body: listingWith('commentshape', [{ id: 'kkk111', numComments: 9 }], null) };
    }
    if (url.pathname === '/r/commentshape/comments/kkk111') {
      return { body: loadFixture('synthetic-comments-unmappable-children.json') };
    }
    return undefined;
  };

  function buildAdapter() {
    const server = createFakeRedditServer({ tokenUrl: TOKEN_URL, route });
    return createRedditAdapter({ ...AUTH, subreddits: ['commentshape'], netClient: fastNetClient(server.transport) });
  }

  it('reports truncated when the post maps but every comment under it does not', async () => {
    const page = (await buildAdapter().fetchIncremental(undefined)) as RedditFetchPage;

    // The post alone would otherwise look like an ordinary page: the listing parsed, the
    // comments request succeeded, and only the ~6-to-1 bulk of the page silently vanished.
    expect(page.documents.map((d) => d.sourceId)).toEqual(['t3_kkk111']);
    expect(page.outcome?.kind).toBe('truncated');
    if (page.outcome?.kind === 'truncated') {
      expect(page.outcome.reason).toContain('3 of 3');
      expect(page.outcome.reason).toContain('r/commentshape');
    }
  });

  it('logs the skipped and total counts against the post whose thread they came from', async () => {
    const adapter = buildAdapter();

    const capture = captureStdoutWrites();
    await adapter.fetchIncremental(undefined);
    const lines = capture.lines().join('\n');
    capture.restore();

    const warning = findLogRecord(lines, 'Reddit comment children could not be mapped to Documents');
    expect(warning).toMatchObject({
      level: 'warn',
      source: 'reddit',
      subreddit: 'commentshape',
      post_id: 'kkk111',
      skipped: 3,
      total: 3,
    });
  });
});

describe('an unreachable subreddit is reported, not passed off as an empty sweep', () => {
  it('reports truncated on a 403, naming the subreddit', async () => {
    const route: Router = () => new Response(null, { status: 403 });
    const server = createFakeRedditServer({ tokenUrl: TOKEN_URL, route });
    const adapter = createRedditAdapter({ ...AUTH, subreddits: ['privatesub'], netClient: fastNetClient(server.transport) });

    const page = (await adapter.fetchIncremental(undefined)) as RedditFetchPage;

    expect(page.documents).toEqual([]);
    expect(page.outcome?.kind).toBe('truncated');
    if (page.outcome?.kind === 'truncated') {
      expect(page.outcome.reason).toContain('403');
      expect(page.outcome.reason).toContain('r/privatesub/new');
    }
  });
});

describe('comment expansion defaults are conservative against the 100 QPM ceiling', () => {
  it('leaves a post with fewer than 3 comments unexpanded by default', async () => {
    const route: Router = (url) =>
      url.pathname === '/r/quietsub/new' ? { body: listingWith('quietsub', [{ id: 'q1', numComments: 2 }], null) } : undefined;
    const server = createFakeRedditServer({ tokenUrl: TOKEN_URL, route });
    const adapter = createRedditAdapter({ ...AUTH, subreddits: ['quietsub'], netClient: fastNetClient(server.transport) });

    const page = await adapter.fetchIncremental(undefined);

    expect(page.documents.map((d) => d.sourceId)).toEqual(['t3_q1']);
    expect(dataUrls(server).some((url) => url.includes('/comments/'))).toBe(false);
  });
});

describe('checkHealth', () => {
  it('reports healthy when the probe succeeds', async () => {
    const route: Router = (url) => (url.pathname === '/r/test/about' ? { body: { kind: 't5', data: {} } } : undefined);
    const server = createFakeRedditServer({ tokenUrl: TOKEN_URL, route });
    const adapter = createRedditAdapter({ ...AUTH, netClient: fastNetClient(server.transport) });

    expect(await adapter.checkHealth()).toEqual({ healthy: true, detail: 'Reddit API returned 200' });
  });

  it('reports unhealthy, never throwing, when the token is rejected even after a refresh attempt', async () => {
    const route: Router = () => new Response(null, { status: 401 });
    const server = createFakeRedditServer({ tokenUrl: TOKEN_URL, route });
    const adapter = createRedditAdapter({ ...AUTH, netClient: fastNetClient(server.transport) });

    const health = await adapter.checkHealth();
    expect(health.healthy).toBe(false);
    expect(health.detail).toContain('refresh attempt');
  });

  it('reports unhealthy, never throwing, when lib/net.ts exhausts retries and throws', async () => {
    const transport: Transport = async () => {
      throw new NetworkError('simulated DNS failure');
    };
    const adapter = createRedditAdapter({ ...AUTH, netClient: fastNetClient(transport) });

    const health = await adapter.checkHealth();
    expect(health.healthy).toBe(false);
    expect(health.detail).not.toContain(AUTH.clientSecret);
  });
});

describe('malformed cursors', () => {
  it('fetchIncremental throws ConfigError on unparseable JSON', async () => {
    const server = createFakeRedditServer({ tokenUrl: TOKEN_URL, route: () => undefined });
    const adapter = createRedditAdapter({ ...AUTH, subreddits: ['testsub'], netClient: fastNetClient(server.transport) });
    await expect(adapter.fetchIncremental('not json')).rejects.toThrow(ConfigError);
  });

  it('fetchIncremental throws ConfigError on a cursor shape it never minted', async () => {
    const server = createFakeRedditServer({ tokenUrl: TOKEN_URL, route: () => undefined });
    const adapter = createRedditAdapter({ ...AUTH, subreddits: ['testsub'], netClient: fastNetClient(server.transport) });
    await expect(adapter.fetchIncremental(JSON.stringify({ pairIndex: 99, after: null }))).rejects.toThrow(ConfigError);
  });

  it('fetchBackfill throws ConfigError on an incremental cursor passed in by mistake', async () => {
    const server = createFakeRedditServer({ tokenUrl: TOKEN_URL, route: () => undefined });
    const adapter = createRedditAdapter({ ...AUTH, subreddits: ['testsub'], netClient: fastNetClient(server.transport) });
    await expect(
      adapter.fetchBackfill(
        { since: new Date('2020-01-01T00:00:00.000Z'), until: new Date('2030-01-01T00:00:00.000Z') },
        JSON.stringify({ subreddit: 'testsub', listing: 'new', after: null }),
      ),
    ).rejects.toThrow(ConfigError);
  });
});

describe('credentials never reach a log line (CLAUDE.md rule 5; composer resolution 3)', () => {
  it('across a full authenticated run, stdout never contains the client secret or the minted bearer token', async () => {
    const route: Router = (url) => {
      if (url.pathname === '/r/testsub/new') return { body: loadFixture('synthetic-listing-new-page1.json') };
      if (url.pathname === '/r/testsub/comments/aaa111') return { body: loadFixture('synthetic-comments-aaa111.json') };
      return undefined;
    };
    const server = createFakeRedditServer({ tokenUrl: TOKEN_URL, route });
    const adapter = createRedditAdapter({ ...AUTH, subreddits: ['testsub'], netClient: fastNetClient(server.transport) });

    const capture = captureStdoutWrites();
    await adapter.fetchIncremental(undefined);
    const joined = capture.lines().join('\n');
    capture.restore();

    expect(joined).not.toContain(AUTH.clientSecret);
    expect(joined).not.toContain('fake-token-1');
    expect(joined).not.toContain('Authorization');
  });
});
