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

**Phase:** 0 — Foundation
**Active tasks:** none
**Next up:** F-03
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
| F-04 | `lib/net.ts` | WIP | F-01, F-03, F-06 | — | Gates all of Phase 1 |
| F-05 | `lib/llm.ts` + `lib/budget.ts` | READY | F-01, F-02, F-03, F-06 | — | Gates all of Phase 2 |
| F-06 | Error taxonomy and logging | DONE | F-01 | — | `e76b023` (1 fix round) |

### Phase 1 — Ingestion

| ID | Task | Status | Blockers | Assigned | Notes |
|---|---|---|---|---|---|
| I-01 | `SourceAdapter` interface and registry | TODO | F-04, F-06 | — | Interface quality determines cost of every future source |
| I-02 | Hacker News adapter | TODO | I-01 | — | Free and unmetered — develop against this one first |
| I-03 | App Store reviews adapter | TODO | I-01 | — | |
| I-04 | Reddit adapter | TODO | I-01 | — | 100 QPM hard limit |
| I-05 | Ingest orchestrator | TODO | I-02, I-03, I-04 | — | |
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
| B-05 | I-05, I-06 | **Nothing can run a TypeScript entry point.** F-02 had to delete its `db:migrate` and `db:seed` scripts: bare `node <file>.ts` cannot resolve this repo's `.js`-import-specifier-to-`.ts`-file convention outside vitest's transform. The seed script is tested but not operationally invokable | A small task adding a runner (`tsx`, or `node --experimental-strip-types` with matching resolution settings), or a change to F-01's module resolution. Needed before any scheduled or CLI-invoked pipeline stage exists |

These three are human-input blockers, not agent-solvable. They gate the phases where
quality actually matters, so front-load them — start labeling during Phase 0 or 1 rather
than discovering the gap when X-02 comes up `READY`.

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
| 2026-08-04 | **`zod` authorized as a dependency** — first departure from the stack table | Runtime schema validation is needed in at least three places: F-03 config validation, and X-03/X-04 validating model JSON against the `PainPoint` schema ("malformed model output is quarantined"). Hand-rolling it three times is worse than one small ubiquitous dependency. No runtime cost impact. Composer decision under the `CLAUDE.md` rule that a dependency needs a task to authorize it |
| 2026-08-04 | Repo-wide criteria are enforced by ESLint, not by inspection | F-06's "every thrown error is an `AppError`" and "no `catch {}`" are claims about the whole repo that no reviewer can verify by reading a diff. They are now lint rules with paired positive/negative tests, so later tasks inherit the guarantee mechanically |
| 2026-08-04 | **Postgres 16 → 18** in the stack table and the F-02 criterion | User decision. Postgres 18.3 is already running locally via brew; pgvector 0.8.6 installed against it and enabled on `fetch_dev` and `fetch_test`. pgvector supports PG 13–18, so nothing in the design is lost, and reusing the running server keeps `pnpm verify` fast and Docker-free |
| 2026-08-04 | Parallel dispatch is the default; one PR per phase | User directive. `CLAUDE.md` §2 *Parallel dispatch* and §3 *Git* now carry the rules: tasks run concurrently when their declared file scopes are disjoint, each in its own worktree, merged back one at a time with `pnpm verify` after each merge. A phase is not finished until its PR against `main` is open |
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
