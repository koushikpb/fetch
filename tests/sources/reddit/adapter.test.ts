import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createNetClient, type NetClient, type Transport } from '../../../lib/net.js';
import { ConfigError, NetworkError, UpstreamError } from '../../../lib/errors.js';
import { createRedditAdapter } from '../../../sources/reddit/adapter.js';
import type { RedditFetchPage } from '../../../sources/reddit/types.js';
import { createFakeRedditServer, type Router } from './support/fake-reddit-server.js';

const FIXTURES_DIR = path.join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'fixtures', 'reddit');
const TOKEN_URL = 'https://fake-reddit-auth.test/token';

function loadFixture(file: string): unknown {
  return JSON.parse(readFileSync(path.join(FIXTURES_DIR, file), 'utf-8'));
}

// Retries never actually fire in the happy-path tests below — 200/401/403/404 all return
// immediately per lib/net.ts's own contract — but the "partial outcome" test deliberately
// triggers a 5xx, so every adapter test uses a single attempt and a no-op sleep uniformly,
// the same way tests/net.test.ts's own `recordSleeps()` keeps retry-bearing tests fast.
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

describe('integration: fetchIncremental against recorded Reddit API fixtures (criterion 5)', () => {
  const route: Router = (url) => {
    if (url.pathname === '/r/testsub/new') {
      const after = url.searchParams.get('after');
      return { body: loadFixture(after === null ? 'listing-new-page1.json' : 'listing-new-page2.json') };
    }
    if (url.pathname === '/r/testsub/top') {
      return { body: loadFixture('listing-top-page1.json') };
    }
    if (url.pathname === '/r/testsub/comments/aaa111') {
      return { body: loadFixture('comments-aaa111.json') };
    }
    if (url.pathname === '/r/testsub/comments/ccc333') {
      return { body: loadFixture('comments-ccc333.json') };
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
    // aaa111 (3 comments) qualifies and expands to 6 bounded comment Documents (see
    // mapping.test.ts for the depth/breadth math); bbb222 (0 comments) does not — if the
    // adapter mistakenly requested its thread, the fake server would throw on the
    // unrouted URL and fail this test loudly.
    expect(page1.documents).toHaveLength(2 + 6);
    expect(page1.documents.map((d) => d.sourceId)).toEqual(
      expect.arrayContaining(['t3_aaa111', 't3_bbb222', 't1_cm1', 't1_c2', 't1_c3', 't1_c4', 't1_c5']),
    );
    expect(page1.cursor).toBe(JSON.stringify({ pairIndex: 0, after: 't3_bbb222' }));
    expect(page1.outcome).toBeUndefined();
    expect(page1.rateLimitHeadroom).toEqual({ remaining: 99, used: 1, resetSeconds: 580 });

    const page2 = (await adapter.fetchIncremental(page1.cursor)) as RedditFetchPage;
    expect(page2.documents).toHaveLength(1 + 2);
    expect(page2.documents.map((d) => d.sourceId)).toEqual(expect.arrayContaining(['t3_ccc333', 't1_ce1', 't1_ce2']));
    expect(page2.cursor).toBe(JSON.stringify({ pairIndex: 1, after: null }));

    const page3 = (await adapter.fetchIncremental(page2.cursor)) as RedditFetchPage;
    expect(page3.documents).toHaveLength(1);
    expect(page3.documents[0]?.sourceId).toBe('t3_ddd444');
    expect(page3.cursor).toBeUndefined();
  });

  it('sends Reddit\'s own limit/raw_json/depth/sort query params, not just this adapter\'s internal defaults', async () => {
    const { server, adapter } = buildAdapter();

    await adapter.fetchIncremental(undefined);

    const calls = server.calls();
    expect(calls.some((c) => c.url === 'https://oauth.reddit.com/r/testsub/new?limit=25&raw_json=1')).toBe(true);
    expect(
      calls.some((c) => c.url === 'https://oauth.reddit.com/r/testsub/comments/aaa111?limit=5&depth=2&sort=top&raw_json=1'),
    ).toBe(true);
  });

  it('never sends the client secret or the minted access token in any request other than the token mint itself', async () => {
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

describe('criterion 3 (fan-out): comment-thread failure returns a partial page, not a lost run', () => {
  it('keeps documents already collected and reports the AppError that stopped expansion', async () => {
    const route: Router = (url) => {
      if (url.pathname === '/r/partialtest/new') {
        return { body: loadFixture('listing-partial.json') };
      }
      if (url.pathname === '/r/partialtest/comments/eee555') {
        return { body: loadFixture('comments-eee555.json') };
      }
      if (url.pathname === '/r/partialtest/comments/fff666') {
        return new Response(null, { status: 500 });
      }
      return undefined;
    };
    const server = createFakeRedditServer({ tokenUrl: TOKEN_URL, route });
    const adapter = createRedditAdapter({
      ...AUTH,
      subreddits: ['partialtest'],
      netClient: fastNetClient(server.transport),
    });

    const page = (await adapter.fetchIncremental(undefined)) as RedditFetchPage;

    // Both posts are real, already-fetched evidence — kept regardless of the comment
    // fan-out failure. eee555's thread succeeded before fff666's failed, so its comment is
    // kept too; fff666's is not, since expansion stopped there.
    const sourceIds = page.documents.map((d) => d.sourceId);
    expect(sourceIds).toEqual(expect.arrayContaining(['t3_eee555', 't3_fff666', 't1_cf1']));
    expect(sourceIds).not.toContain('t1_cg_fff666_never_fetched');
    expect(page.documents).toHaveLength(3);

    expect(page.outcome?.kind).toBe('partial');
    if (page.outcome?.kind === 'partial') {
      expect(page.outcome.error).toBeInstanceOf(UpstreamError);
    }
  });
});

describe('criterion 1: OAuth token refresh handled transparently — expiry mid-run does not fail the run', () => {
  const listingNew = {
    kind: 'Listing',
    data: {
      after: null,
      children: [
        {
          kind: 't3',
          data: {
            id: 'p1',
            name: 't3_p1',
            title: 'first post',
            selftext: 'body',
            author: 'author-one',
            created_utc: 1700000000,
            score: 1,
            num_comments: 1,
            upvote_ratio: 0.9,
            permalink: '/r/expireydemo/comments/p1/first_post/',
          },
        },
      ],
    },
  };
  const listingTop = {
    kind: 'Listing',
    data: {
      after: null,
      children: [
        {
          kind: 't3',
          data: {
            id: 'p2',
            name: 't3_p2',
            title: 'second post',
            selftext: 'body',
            author: 'author-two',
            created_utc: 1700000500,
            score: 1,
            num_comments: 1,
            upvote_ratio: 0.9,
            permalink: '/r/expireydemo/comments/p2/second_post/',
          },
        },
      ],
    },
  };
  function commentsFor(postName: string, commentId: string): unknown {
    return [
      { kind: 'Listing', data: { children: [] } },
      {
        kind: 'Listing',
        data: {
          children: [
            {
              kind: 't1',
              data: {
                id: commentId,
                name: `t1_${commentId}`,
                author: 'commenter',
                body: 'a reply',
                created_utc: 1700000100,
                score: 1,
                parent_id: postName,
                link_id: postName,
                replies: '',
              },
            },
          ],
        },
      },
    ];
  }
  const route: Router = (url) => {
    if (url.pathname === '/r/expireydemo/new') return { body: listingNew };
    if (url.pathname === '/r/expireydemo/top') return { body: listingTop };
    if (url.pathname === '/r/expireydemo/comments/p1') return { body: commentsFor('t3_p1', 'c1') };
    if (url.pathname === '/r/expireydemo/comments/p2') return { body: commentsFor('t3_p2', 'c2') };
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
  it('includes only posts within range, and stops paginating a subreddit once it pages past range.since', async () => {
    const route: Router = (url) => {
      if (url.pathname === '/r/backfillsub/new') {
        return { body: loadFixture('listing-backfill-page1.json') };
      }
      if (url.pathname === '/r/backfillsub/comments/postyinrange') {
        return { body: loadFixture('comments-postyinrange.json') };
      }
      // A request for `after=t3_shouldnotbefetched` (or anything else) means the adapter
      // ignored `passedWindow` and kept paginating — deliberately unrouted so that bug
      // fails loudly instead of silently succeeding.
      return undefined;
    };
    const server = createFakeRedditServer({ tokenUrl: TOKEN_URL, route });
    const adapter = createRedditAdapter({
      ...AUTH,
      subreddits: ['backfillsub'],
      netClient: fastNetClient(server.transport),
    });

    const page = (await adapter.fetchBackfill(
      { since: new Date('2025-06-01T00:00:00.000Z'), until: new Date('2025-06-30T23:59:59.999Z') },
      undefined,
    )) as RedditFetchPage;

    const sourceIds = page.documents.map((d) => d.sourceId);
    expect(sourceIds).toEqual(expect.arrayContaining(['t3_postyinrange', 't1_cg1']));
    expect(sourceIds).not.toContain('t3_postxtoonew');
    expect(sourceIds).not.toContain('t3_postztooold');
    // Only one subreddit configured, and it is exhausted after this single page (having
    // paged past range.since) — nothing left to backfill.
    expect(page.cursor).toBeUndefined();
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

  it('fetchIncremental throws ConfigError on an out-of-range pairIndex', async () => {
    const server = createFakeRedditServer({ tokenUrl: TOKEN_URL, route: () => undefined });
    const adapter = createRedditAdapter({ ...AUTH, subreddits: ['testsub'], netClient: fastNetClient(server.transport) });
    await expect(adapter.fetchIncremental(JSON.stringify({ pairIndex: 99, after: null }))).rejects.toThrow(ConfigError);
  });
});

describe('credentials never reach a log line (CLAUDE.md rule 5; composer resolution 3)', () => {
  it('across a full authenticated run, stdout never contains the client secret or the minted bearer token', async () => {
    const route: Router = (url) => {
      if (url.pathname === '/r/testsub/new') return { body: loadFixture('listing-new-page1.json') };
      if (url.pathname === '/r/testsub/comments/aaa111') return { body: loadFixture('comments-aaa111.json') };
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
