# Reddit fixtures — provenance

**Every file in this directory is hand-authored, not recorded.** The `synthetic-` filename
prefix is there so nobody has to read this file to find that out. Do not describe these as
"recorded fixtures", in a test name or anywhere else.

## Why they are not recorded

Fix round 1 of I-04 was asked to replace these with real responses captured from Reddit's
public, unauthenticated JSON endpoints (`https://www.reddit.com/r/<sub>/new.json`,
`https://www.reddit.com/r/<sub>/comments/<id>.json`), then redact identity fields while
preserving shape.

That recording was attempted on **2026-08-05** and failed. Every `.json` endpoint returned
**HTTP 403** with Reddit's network-security interstitial (an HTML page reading *"You've been
blocked by network security"*), not a JSON body. Attempted, each once, with a descriptive
user agent (`fetch-research/0.1 (personal project; contact <email>)`) and **no credentials of
any kind**:

| URL | Result |
| --- | --- |
| `https://www.reddit.com/r/selfhosted/new.json?limit=5&raw_json=1` | 403, HTML block page |
| `https://old.reddit.com/r/selfhosted/new.json?limit=3&raw_json=1` | 403, HTML block page |
| `https://api.reddit.com/r/selfhosted/new?limit=3&raw_json=1` | 403, HTML block page |
| `https://www.reddit.com/r/selfhosted/new/.json?limit=3&raw_json=1` | 403, HTML block page |
| `https://www.reddit.com/r/selfhosted/comments/<id>.json?raw_json=1` | 403, HTML block page |
| `https://www.reddit.com/` (control) | 200 |
| `https://hn.algolia.com/api/v1/search` (control) | 200 |

The two controls establish that outbound networking works and that Reddit's edge is
reachable — it is unauthenticated JSON API access specifically that is blocked. The obvious
workarounds (a browser user agent, a proxy, a third-party mirror of Reddit data) are all
ruled out by `CLAUDE.md` rule 4: public APIs on their own terms, no circumvention, no
third-party data proxies of uncertain provenance.

**What this leaves open:** the parser in `sources/reddit/mapping.ts` has still never met a
real Reddit payload. Re-record these against the OAuth host (`https://oauth.reddit.com`) once
real credentials exist — that is the endpoint the adapter actually calls in production, and
it is reachable with a token where the public JSON host is not.

## What the shapes are based on

The field names, nesting, and value types below were written from Reddit's documented
`Listing` / `t3` / `t1` / `more` structures, not observed from a response:

- `synthetic-listing-*.json` — a `Listing` envelope (`{kind, data: {after, before, dist,
  children}}`) whose `children` are `{kind: "t3", data: {...}}`.
- `synthetic-comments-*.json` — the two-element `[postListing, commentsListing]` array the
  `/comments/<id>` endpoint returns, with nested `replies` sub-`Listing`s and one
  `{kind: "more"}` stub.
- `synthetic-listing-new-page1.json`'s first post carries a wide (~60-field) `t3` node, so
  the mapper is at least exercised against a node far larger than the fields it reads, and
  `Document.raw` is proven to keep the untouched node. The remaining fixtures are deliberately
  narrow — they exist for one edge case each and a full node would only obscure it.
- `synthetic-listing-unmappable-children.json` is a listing whose per-item field names have
  all been renamed (`id` → `identifier`, `created_utc` → `created_at_utc`, …). It is the
  regression fixture for "Reddit renamed a per-item field": every child fails to map, and the
  page must not read as a clean empty success.

## Identity values

No real usernames, user ids, or `author_fullname` values appear here. Authors are invented
and self-describing (`three_banks_no_luck`, `renamed_shape_poster`); `author_fullname` values
are `t2_placeholder<NN>`. Some comment bodies describe their own role in a test (e.g. "beyond
the configured breadth and must not appear in output") — another tell that these are authored,
not captured.

If these are ever replaced with genuine recordings, redact those identity fields before
committing (`CLAUDE.md` rule 5) — same type, same shape, obviously fake value — and rewrite
this file to say which endpoints were captured and when.
