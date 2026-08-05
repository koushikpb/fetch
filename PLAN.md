# PLAN.md

Single source of truth for project status. **Composer-owned — subagents never edit this
file.** If a change isn't recorded here, it didn't happen.

---

## How to use this file

The composer updates the tracker and appends a changelog entry after every completed,
rejected, or blocked task. The update is part of the task, not an afterthought — a task
whose `PLAN.md` entry is missing is not done.

**Status values**

| Status | Meaning |
|---|---|
| `TODO` | Not started, blockers not yet clear |
| `READY` | All blockers `DONE`, eligible for dispatch |
| `WIP` | Dispatched to a subagent, in flight |
| `REVIEW` | Subagent reported complete, awaiting composer review |
| `BLOCKED` | Cannot proceed; blocker recorded in the Blockers section |
| `DONE` | Criteria verified by composer, committed |
| `DEFERRED` | Explicitly postponed by composer decision |

**Session start checklist for the composer**

1. Read `CLAUDE.md` and `SPEC.md`.
2. Read this file top to bottom.
3. Recompute `READY` — any `TODO` whose blockers are all `DONE` becomes `READY`.
4. Check the Blockers section for anything now resolvable.
5. Dispatch the next `READY` task.

---

## Current state

**Phase:** 1 — Ingestion
**Active tasks:** I-02 ∥ I-03 ∥ I-04 (wave 3 — the three adapters, concurrent)
**Next up:** I-05 ingest orchestrator

**Phase 0 shipped.** PR #1 merged to `main` on 2026-08-05 as `eced880` — six `SPEC.md` tasks
plus three composer-created reconciliation tasks, 221 tests green.

**Phase 1 wave plan.** More sequential than Phase 0 by nature: everything downstream depends on
the `SourceAdapter` interface, so the three adapters are the one big parallel win.

| Wave | Tasks | Why grouped |
|---|---|---|
| 1 | R-04, R-05 | Both clear blockers (B-06, B-05). Disjoint scopes, so concurrent |
| 2 | I-01 | Designed against the contract R-04 settles |
| 3 | I-02, I-04 | Two adapters, disjoint files. I-03 joins if scopes stay clean |
| 4 | I-05 | Needs all adapters |
| 5 | I-06 | Needs the orchestrator |
**Rolling 30-day projected spend:** $0.00 (ceiling: $70.00)

**Phase 0 dispatch order:** F-01 → F-06 → **(F-02 ∥ F-03)** → **(F-04 ∥ F-05)** → final
review → PR. This differs from the `SPEC.md` blocker graph; see the decisions log entries
dated 2026-08-04 for why.

**Parallel waves.** Tasks in a wave have disjoint file scopes and run concurrently, each in
its own worktree on a `task/<id>-<slug>` branch off `phase/0-foundation`, merged back one at
a time with `pnpm verify` re-run after each merge.

| Wave | Tasks | Known contention | Resolution |
|---|---|---|---|
| 1 | F-02, F-03 | `package.json`, `pnpm-lock.yaml` — both add dependencies | Hand-merge `package.json`, regenerate the lockfile with `pnpm install` |
| 2 | F-04, F-05 | none expected — `lib/net.ts` and `lib/llm.ts`/`lib/budget.ts` are disjoint, and both ESLint overrides already exist | Sequence them if either turns out to need `eslint.config.js` |

---

## Task tracker

### Phase 0 — Foundation

| ID | Task | Status | Blockers | Assigned | Notes |
|---|---|---|---|---|---|
| F-01 | Repo scaffold and tooling | DONE | — | — | `e5814f1` |
| F-02 | Database schema and migrations | DONE | F-01 | — | `97b3834` (1 fix round) |
| F-03 | Config and secrets | DONE | F-01, F-06 | — | `201080d` (1 fix round) |
| R-01 | Reconcile `drizzle.config.ts` with the `process.env` ban | DONE | F-02, F-03 | — | `964c65e` — composer-created; merge fallout, not a `SPEC.md` task |
| F-04 | `lib/net.ts` | DONE | F-01, F-03, F-06 | — | `e18bf90` — review clean first pass |
| F-05 | `lib/llm.ts` + `lib/budget.ts` | DONE | F-01, F-02, F-03, F-06 | — | `f8ed738` (1 fix round) |
| R-02 | Derive `allowDefaultProject` from disk state | DONE | F-04, F-05 | — | `5f00237` — composer-created; unblocks the whole repo's lint |
| R-03 | Phase 0 final-review fix wave | DONE | all F-* | — | `7be8a53` — composer-created; closes the whole-branch review's Important findings |
| F-06 | Error taxonomy and logging | DONE | F-01 | — | `e76b023` (1 fix round) |

### Phase 1 — Ingestion

| ID | Task | Status | Blockers | Assigned | Notes |
|---|---|---|---|---|---|
| R-04 | Settle `lib/net.ts` terminal-failure contract | DONE | F-04 | — | `944b979` — clears **B-06**; review clean first pass |
| R-05 | Make TypeScript entry points runnable | DONE | F-01 | — | `7b201a1` (1 fix round) — clears **B-05**; adds `db:migrate`, `db:seed`, `pnpm smoke` |
| I-01 | `SourceAdapter` interface and registry | DONE | F-04, F-06, R-04 | — | `fea7713` (1 fix round) — Interface quality determines cost of every future source |
| I-02 | Hacker News adapter | DONE | I-01 | — | `26ff1fc` (2 fix rounds) — merged `3ca1ade`. Round 1 fixed permanent evidence loss at tied timestamps; round 2 fixed the silent stall that fix introduced. Verified by mutation testing |
| I-03 | App Store reviews adapter | DONE | I-01 | — | `2a61852` (1 fix round) — merged `8a96349`. Fix carried truncation through `partial` outcomes and settled the `cursor`/`outcome` orthogonality rule |
| I-04 | Reddit adapter | DONE | I-01 | — | `b92d3de` (2 fix rounds) — merged. Round 1 fixed cursor advance past unexpanded pages; round 2 signalled unmappable comment children. **Inert until B-09** (no credentials); one parked finding tied to it |
| I-05 | Ingest orchestrator | TODO | I-02, I-03, I-04 | — | Brief must carry **B-08** (new table + forward-only migration for cursor persistence) and the `createRegistry(config)` reshape — the registry currently constructs adapters with no configuration, so every entry is inert |
| I-06 | Scheduling | TODO | I-05 | — | |

### Phase 2 — Filter and extract

| ID | Task | Status | Blockers | Assigned | Notes |
|---|---|---|---|---|---|
| X-01 | Embedding pipeline | TODO | F-05, I-05 | — | |
| X-02 | Unmet-need prefilter | TODO | X-01 | — | Needs labeled eval set before dispatch |
| X-03 | Extraction prompt and fixtures | TODO | F-05 | — | Can run parallel to X-01/X-02 |
| X-04 | Batch extraction worker | TODO | X-02, X-03 | — | |

### Phase 3 — Cluster and score

| ID | Task | Status | Blockers | Assigned | Notes |
|---|---|---|---|---|---|
| C-01 | Clustering | TODO | X-04 | — | Needs hand-labeled cluster set |
| C-02 | Cross-source dedup | TODO | C-01 | — | |
| C-03 | Scoring rubric | TODO | C-02 | — | |
| C-04 | Solution-gap detection | TODO | C-03 | — | The differentiator; expect multiple review rounds |
| C-05 | Calibration harness | TODO | C-04 | — | |

### Phase 4 — Synthesis

| ID | Task | Status | Blockers | Assigned | Notes |
|---|---|---|---|---|---|
| S-01 | Synthesis prompt and fixtures | TODO | C-05 | — | |
| S-02 | Brief generator | TODO | S-01 | — | |
| S-03 | Citation integrity check | TODO | S-02 | — | |

### Phase 5 — Interface

| ID | Task | Status | Blockers | Assigned | Notes |
|---|---|---|---|---|---|
| W-01 | App shell | TODO | F-02 | — | Can start early, parallel to Phase 2–3 |
| W-02 | Ranked opportunity table | TODO | W-01, C-05 | — | |
| W-03 | Brief detail and evidence drill-down | TODO | W-02, S-03 | — | |
| W-04 | Run history | TODO | W-01, I-06 | — | |

### Phase 6 — Operations

| ID | Task | Status | Blockers | Assigned | Notes |
|---|---|---|---|---|---|
| O-01 | Budget enforcement end to end | TODO | F-05, S-02 | — | |
| O-02 | Observability | TODO | F-06, I-06 | — | |
| O-03 | Cost projection in verify | TODO | O-01 | — | Replaces the F-01 stub |

### Phase 7 — Extensions

| ID | Task | Status | Blockers | Assigned | Notes |
|---|---|---|---|---|---|
| E-01 | X adapter behind a flag | DEFERRED | I-01, O-03 | — | ~$250/mo at 50k reads; needs explicit ceiling increase |
| E-02 | Review-site adapter | DEFERRED | I-01 | — | ToS review required before implementation |
| E-03 | Export | DEFERRED | W-03 | — | |

---

## Open blockers

*Recorded by the composer when a task cannot proceed. Each entry names the blocking
condition, the task it blocks, and what would resolve it.*

| # | Blocks | Condition | Resolution needed |
|---|---|---|---|
| B-01 | X-02 | No labeled evaluation set for the unmet-need prefilter | Hand-label ~300 documents as candidate/noise before X-02 is dispatchable |
| B-02 | C-01 | No hand-labeled cluster set | Hand-cluster ~100 extracted pain points |
| B-03 | C-04 | No labeled saturated-market examples | Identify ≥5 clusters with known mature solutions for negative testing |
| B-04 | X-01, X-02 | **No embedding provider is named anywhere in the spec or stack table, and Anthropic does not offer an embeddings API.** The whole cost thesis rests on the embedding prefilter, so this is a load-bearing gap, not a detail | Choose a provider and model, add it to the stack table, and price it at 50k documents/month against the $70 ceiling. F-02 pins the vector column at `1536` as a placeholder; a different model means a forward migration |
| B-07 | first CI setup, or a second contributor | **Test scratch-database provisioning hardcodes the Postgres role `nick`** (`tests/db/scratch-database.ts`). `pnpm verify` cannot run in any environment lacking that exact role. The natural fix — an env-var override — is blocked because `eslint.config.js` deliberately keeps the `process.env` ban active for `tests/**`, asserted by its own test | Composer ruling: **deferred**, not forgotten. No CI exists and this is a single-contributor repo, so nothing breaks today, and the sharper half of the risk (two files duplicating the provisioning block, free to drift) is already fixed. Unblocking it means widening a deliberate ban across `eslint.config.js` and a test helper as a matched pair — do that when a second environment actually exists, not speculatively |
| B-08 | I-05 | **There is nowhere to persist an adapter cursor between runs.** `db/schema.ts` has `documents`, `embeddings`, `pain_points`, `clusters`, `cluster_members`, `scores`, `briefs`, `runs` — none holds source state. `fetchIncremental(cursor)` is specified to receive exactly the `Cursor` the previous `FetchPage` returned, and I-01 resolution 3 makes the cursor opaque precisely so I-05 can "store and replay it". Without storage every run restarts from scratch: full re-fetch each time, rate limits blown, and the entire cursor design is dead code | Composer ruling: **I-05's brief authorizes a new table and a forward-only migration.** One row per source holding the opaque cursor and an updated timestamp. It is *mutable* state by nature — the high-water mark advances — so the append-only trigger pattern that guards `documents` must **not** be applied to it. Whether backfill cursors persist alongside incremental ones is I-05's call with stated justification, since backfill cursors are per-range and one-shot while the incremental cursor is a long-lived high-water mark. Caught during pre-dispatch review, before I-05 was briefed |
| B-09 | I-04 criterion 5; any live Reddit ingestion | **Reddit blocks unauthenticated JSON API access, so the Reddit adapter's fixtures cannot be recorded and its parser has never met a real payload.** I-04's fix round attempted this properly — descriptive user agent, no credentials, `www`/`old`/`api` hosts and `/comments/<id>.json` — and got HTTP 403 with a "blocked by network security" page every time, while `https://www.reddit.com/` returned 200. **Composer verified independently: `.json` API 403, homepage 200.** Every workaround (rotating agents, proxies, unofficial mirrors) is barred by CLAUDE.md rule 4, and the implementer correctly reported rather than improvising. Criterion 5 ("integration test against **recorded** fixtures") is therefore unmet on the word "recorded"; fixtures are renamed `synthetic-*` with a provenance README, and one post node was widened to ~60 real `t3` field names taken from documentation and labeled as such | **User decision.** Reddit ingestion needs a registered Reddit app (client id + secret) regardless — without credentials the adapter cannot run at all, so this blocker gates live Reddit data, not just the fixtures. Once credentials exist, re-record against `oauth.reddit.com` (reachable with a token where the public host is not) and redact identity fields while preserving shape. Until then the Hacker News and App Store adapters carry Phase 1, both of which are free and unauthenticated. Do **not** ask an agent to source credentials |
| ~~B-06~~ | ~~I-02, I-04~~ | **RESOLVED 2026-08-05 by R-04 (`944b979`).** ~~`lib/net.ts`'s terminal-failure contract is asymmetric.~~ An exhausted 429 throws `RateLimitError`, but an exhausted 5xx returns the raw `Response`. An adapter author must therefore branch on `response.status >= 500` *in addition* to catching typed errors, or a persistently-failing upstream silently reads as "got a response" | Settle it in **I-01**, when the `SourceAdapter` consumer contract is designed and we know what adapters actually need. Either add an `HttpStatusError` to `lib/errors.ts` and throw symmetrically, or make returning the response the documented contract for every non-retryable status including 429 |
| ~~B-05~~ | ~~I-05, I-06~~ | **RESOLVED 2026-08-05 by R-05 (`7b201a1`).** ~~Nothing can run a TypeScript entry point.~~ F-02 had to delete its `db:migrate` and `db:seed` scripts: bare `node <file>.ts` cannot resolve this repo's `.js`-import-specifier-to-`.ts`-file convention outside vitest's transform. The seed script is tested but not operationally invokable | A small task adding a runner (`tsx`, or `node --experimental-strip-types` with matching resolution settings), or a change to F-01's module resolution. Needed before any scheduled or CLI-invoked pipeline stage exists |

B-01 through B-04 are human-input blockers, not agent-solvable. They gate the phases where
quality actually matters, so front-load them — start labeling during Phase 0 or 1 rather
than discovering the gap when X-02 comes up `READY`. **B-04 is the urgent one**: it is not a
labeling chore but an unmade architectural decision that the entire cost thesis rests on.

B-07 and B-08 are agent-solvable and scheduled: B-08 is folded into I-05's brief, B-07 is
deferred until a second environment exists. **B-09 is human-input** — it needs a registered
Reddit app, and no agent should be asked to source credentials.

---

## Decisions log

*Composer records architectural and scope decisions here with reasoning, so later sessions
don't relitigate them.*

| Date | Decision | Reasoning |
|---|---|---|
| — | X/Twitter excluded from v1 | $0.005/post read makes it ~4× the cost of everything else combined |
| — | Single language (TypeScript) end to end | Subagents are stateless; context-switching languages mid-project raises defect rate |
| — | Embedding prefilter mandatory before any LLM call | ~10× cost difference between filtered and unfiltered pipelines |
| — | Opus never called at runtime | Composer-only model; runtime routing is Haiku extract / Sonnet synthesize |
| 2026-08-04 | F-02 added as an implicit blocker of F-05 | F-05's criterion requires every model call to record tokens and cost "to `runs`". The `runs` table is created by F-02. Building F-05 first would mean writing token accounting against a table that does not exist |
| 2026-08-04 | F-06 added as a blocker of F-03, F-04, F-05; dispatched second | F-06's criterion is repo-wide — "every thrown error in the repo is an instance of a class from `lib/errors.ts`". Config, net, and llm all throw. Building the taxonomy after them guarantees rework |
| 2026-08-04 | Node 22 pinned via Homebrew `node@22`; no `use-node-version` in `.npmrc` | pnpm 11 imports `node:sqlite` and refuses to start on Node < 22.13, so the toolchain self-enforces the pin. A second version declaration would be a redundant source of truth |
| 2026-08-04 | `O-04` in the F-01 spec text read as a typo for `O-03` | No task `O-04` exists anywhere; `O-03 — Cost projection in verify` is described in `PLAN.md` as replacing the F-01 stub |
| 2026-08-05 | **B-06 resolved: `lib/net.ts` throws when it gave up, returns when the server answered definitively** | Exhausted 5xx now throws (new `UpstreamError`), joining exhausted 429; non-retryable 4xx still returns a `Response`. Derived from consumer needs, not tidiness: I-02 must read a 404 for a deleted Hacker News item without an exception, while I-05 needs a broken upstream to surface as a catchable error it can record as `PARTIAL`. Lifts the F-04-era constraint against adding a fourth error class |
| 2026-08-05 | **`tsx` authorized as a devDependency** — second departure from the stack table | Nothing could run a TypeScript entry point (B-05), so `db/seed.ts` was tested but not invokable and I-05/I-06 had no way to exist. `tsx` is the smallest fix for the `.js`-specifier convention `tsconfig.json` already commits to; changing module resolution instead would touch every import in the repo |
| 2026-08-04 | **`zod` authorized as a dependency** — first departure from the stack table | Runtime schema validation is needed in at least three places: F-03 config validation, and X-03/X-04 validating model JSON against the `PainPoint` schema ("malformed model output is quarantined"). Hand-rolling it three times is worse than one small ubiquitous dependency. No runtime cost impact. Composer decision under the `CLAUDE.md` rule that a dependency needs a task to authorize it |
| 2026-08-04 | Repo-wide criteria are enforced by ESLint, not by inspection | F-06's "every thrown error is an `AppError`" and "no `catch {}`" are claims about the whole repo that no reviewer can verify by reading a diff. They are now lint rules with paired positive/negative tests, so later tasks inherit the guarantee mechanically |
| 2026-08-04 | **Postgres 16 → 18** in the stack table and the F-02 criterion | User decision. Postgres 18.3 is already running locally via brew; pgvector 0.8.6 installed against it and enabled on `fetch_dev` and `fetch_test`. pgvector supports PG 13–18, so nothing in the design is lost, and reusing the running server keeps `pnpm verify` fast and Docker-free |
| 2026-08-04 | Parallel dispatch is the default; one PR per phase | User directive. `CLAUDE.md` §2 *Parallel dispatch* and §3 *Git* now carry the rules: tasks run concurrently when their declared file scopes are disjoint, each in its own worktree, merged back one at a time with `pnpm verify` after each merge. A phase is not finished until its PR against `main` is open |
| 2026-08-05 | **When a sort key is not unique, err toward re-fetching, never toward skipping** | I-02's review reproduced permanent evidence loss: Hacker News `created_at_i` is a whole-second timestamp, not a unique key, so claiming the maximum fetched value as an exclusive cursor boundary excluded an unfetched item sharing that second on *every* subsequent call. Dedup on `(source, source_id)` makes a re-fetch free; a skip is permanent and violates rule 1. Generalizes to every adapter: the safe claim is the highest value strictly below the maximum |
| 2026-08-05 | **`cursor` and `outcome` are orthogonal; a fan-out adapter may return a defined `cursor` under `outcome: 'truncated'`** | `cursor` answers "where do I resume", `outcome` answers "was this page's coverage complete". I-01's worked example conflated them because it described a single linear walk, where they coincide. Forcing `cursor: undefined` because one (app, territory) pair hit a permanent 500-review ceiling would discard the high-water mark for every other pair, so every later poll re-walks from scratch forever. `sources/types.ts`'s doc amended; I-03's adapter was already right. `fetchBackfill` keeps `cursor: undefined` — bounded one-shot range, so the literal phrasing does apply there |
| 2026-08-05 | **`FetchPageOutcome`'s `partial` variant carries an optional `truncatedReason`, rather than `outcome` becoming an array** | A fan-out page can be both truncated (one pair capped) and partial (another pair threw), and the single-value union dropped the truncation. But the two are not symmetric: `partial` sets the page's *disposition* (run incomplete, retry it), while truncation is a *standing fact about coverage* that can accompany any disposition. A rider on `partial` states exactly that, is purely additive, and leaves the Hacker News and Reddit adapters untouched — where an array would rename the field and churn two adapters and the fake to express a compound with only two members, one of which already aggregates by joining strings |
| 2026-08-04 | Built-in error *construction* banned, not just *throwing* | Banning only `throw new Error(...)` left `const e = new Error(); throw e;` as a bypass. Banning the `NewExpression` outside `lib/errors.ts` closes it syntactically, with no need for a custom type-aware rule. `tests/**` is exempt from the construction ban only, so tests can still synthesize a foreign error to prove `cause` wrapping |

---

## Changelog

*Newest first. One entry per task transition. Format:*

```
### YYYY-MM-DD — <TASK-ID> <STATUS>
**Summary:** one line
**Files:** list
**Criteria:** met / unmet with evidence
**Cost impact:** none | +$X/mo
**Follow-ups:** anything the subagent flagged out of scope
```

---

### 2026-08-05 — F-02 DONE
**Summary:** Drizzle schema for all eight tables, pgvector enabled, four forward-only
migrations, and a deterministic 20-document seed across all three sources.
**Files:** db/schema.ts, db/index.ts, db/seed.ts, db/migrate.ts, drizzle.config.ts,
drizzle/0000–0003 + meta, tests/db/*.test.ts, tests/fixtures/documents/*, package.json,
pnpm-workspace.yaml
**Criteria:** all five MET after one fix round (82 tests). Every criterion is proven by a
structural query against a live database — `information_schema` for the `timestamptz` rule, a
recursive FK/array walk with a negative control for traceability — not by trusting the schema
file. The reviewer independently reproduced all of it on its own scratch databases.
**Cost impact:** none.
**Follow-ups:** The review found `TRUNCATE documents CASCADE` silently bypassing the
append-only trigger — Postgres fires triggers on `TRUNCATE` only when declared
`BEFORE TRUNCATE ... FOR EACH STATEMENT`. Closed by migration `0003`. Composer signed off on
schema columns beyond the bare table list: they are named verbatim in F-05's and X-03's
criteria, and forward-only migrations make including them now cheaper than three later ones.
Deferred minor: `drizzle.config.ts`'s hardcoded `DATABASE_URL` fallback masks a missing env
var rather than failing fast. New blocker B-05 registered.

### 2026-08-05 — F-03 DONE
**Summary:** Typed config loader with zod schema validation, aggregate fail-fast reporting,
and secret redaction that survives every serialization route.
**Files:** lib/config.ts, .env.example, eslint.config.js, tests/config.test.ts,
tests/eslint-rules.test.ts, package.json
**Criteria:** all three MET after one fix round (104 tests).
**Cost impact:** none.
**Follow-ups:** The review found a Critical the implementer's own tests missed: secrets were
ordinary enumerable own properties, so `{...config}`, `Object.entries`, `Object.keys`, and
`structuredClone` all leaked them verbatim. The reviewer reproduced the real exploit —
`log.info('booted', {...config})` printing `ANTHROPIC_API_KEY` to stdout, because the logger
spreads its fields. Fixed by making the four secret fields non-enumerable and non-writable.
Also closed a `process["env"].FOO` bracket-notation bypass in the lint ban. Worth recording
that the first fix attempt (private `#` fields plus getters) crashed Vitest's `toEqual`:
Vitest clones instances without running the constructor, so the private-field slot is never
initialized.

### 2026-08-04 — F-06 DONE
**Summary:** `AppError` taxonomy, structured single-line JSON logger, `AsyncLocalStorage`
run correlation, and ESLint enforcement of the two repo-wide criteria.
**Files:** lib/errors.ts, lib/log.ts, lib/run-context.ts, eslint.config.js,
tests/errors.test.ts, tests/log.test.ts, tests/eslint-rules.test.ts
**Criteria:** all three MET after one fix round (62 tests). Criterion 1 is met *within a
stated syntactic boundary* — see follow-ups.
**Cost impact:** none.
**Follow-ups:** First review found three Important defects, all real: the `lib/errors.ts`
lint override had silently disabled F-01's bare-`fetch` ban; the logger let a caller-supplied
`run_id` field leak through when outside a run; and criterion 1's enforcement caught only
literal inline `throw new Error(...)`, missing indirect throw and bare rethrow. All fixed.
Four residual bypasses of criterion 1 are documented and accepted: errors originating in
dependencies, `no-useless-catch` requiring the catch body to be exactly one rethrow,
Promise `.catch()` handlers, and aliased-identifier constructors — the last needs type
information to close. Deferred minor: a `callee.property.name` esquery clause would also
catch `new globalThis.Error(...)`.
**Note for later tasks:** `eslint.config.js` now uses type-aware linting via
`parserOptions.projectService` with a hand-maintained `allowDefaultProject` list of literal
paths and an **8-file cap**. A task adding new `lintText` fixture paths in
`tests/eslint-rules.test.ts` must reuse an entry or extend that list; hitting the cap is a
blocker to report, not a reason to restructure `tsconfig.json`.

### 2026-08-04 — F-01 DONE
**Summary:** pnpm workspace, strict TypeScript, ESLint, Prettier, Vitest, Node 22 pin,
directory skeleton, and the `verify` gate scaffolded.
**Files:** package.json, pnpm-lock.yaml, tsconfig.json, eslint.config.js, vitest.config.ts,
.prettierrc.json, .prettierignore, .gitignore, scripts/cost-projection.ts,
tests/eslint-rules.test.ts, and placeholder `types.ts` in all 12 architecture directories
**Criteria:** all four MET. `pnpm install && pnpm verify` passes from a clean checkout
(reviewer independently reproduced it); `strict` and `noUncheckedIndexedAccess` both set;
the three ESLint prohibitions are proven behaviourally by `tests/eslint-rules.test.ts`,
which asserts on real `lintText` rule IDs rather than on config shape.
**Cost impact:** none — cost projection is the `O-03` stub, prints $0.00.
**Follow-ups:** Two deferred minors, both non-blocking — a new `ESLint` instance is
constructed per test, and `format`/`format:check` scripts are unrequested surface area.
`typescript` is pinned to `^5.9.3` because `typescript-eslint@8.66.0` caps at `<6.1.0`
while TypeScript's `latest` is now `7.0.2`; a future TypeScript bump must re-check that
peer range or lint breaks.

### — Project initialized
**Summary:** `CLAUDE.md`, `SPEC.md`, and `PLAN.md` created. Phase 0 open, F-01 `READY`.
**Files:** CLAUDE.md, SPEC.md, PLAN.md
**Criteria:** n/a
**Cost impact:** none
**Follow-ups:** Three human-input blockers (B-01, B-02, B-03) registered. Labeling work
should begin in parallel with Phase 0 rather than blocking Phase 2 later.
