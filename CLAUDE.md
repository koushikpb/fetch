# CLAUDE.md

Operating manual for every agent working in this repository. Read it in full before taking
any action. If a task brief conflicts with a rule here, this file wins — surface the
conflict, do not resolve it yourself.

---

## 1. Project

**Fetch** ingests public conversations from Hacker News, App Store reviews, and Reddit,
filters them for genuine unmet needs, clusters recurring complaints, scores each cluster
against solutions that already exist, and emits ranked opportunity briefs linked back to
primary evidence.

The thesis in one line: *most idea-discovery tools surface complaints; the value is in
surfacing complaints that nothing adequately solves yet.*

Explicit non-goals:

- Not a lead-generation or outbound tool. Fetch finds problems, not customers.
- Not brand monitoring or mention alerting.
- No X/Twitter ingestion in v1. Official read pricing is $0.005/post, which alone would
  exceed the entire infrastructure budget. The adapter interface accommodates it later
  behind a flag; do not implement it unless a task says to.

### Architecture

```
sources/          adapters, one per platform, all conforming to SourceAdapter
  ├─ hackernews   Algolia + Firebase, free, unmetered
  ├─ appstore     iTunes RSS review feeds, free
  └─ reddit       OAuth, free tier, 100 QPM
        ↓
ingest/           normalize into the append-only `documents` table
        ↓
filter/           embedding pass; drops ~90% as noise before any LLM sees it
        ↓
extract/          Haiku 4.5, batch API, structured pain-point objects
        ↓
cluster/          pgvector + agglomerative clustering, cross-source dedup
        ↓
score/            frequency · intensity · recency decay · solution gap
        ↓
synthesize/       Sonnet 5, opportunity briefs on qualifying clusters only
        ↓
web/              Next.js UI, ranked table, drill-down to evidence
```

### Stack

| Layer | Choice | Rationale |
|---|---|---|
| Language | TypeScript, strict | One language end to end; subagents never context-switch |
| Runtime | Node 22 LTS | |
| Web | Next.js 15, App Router | |
| Database | Postgres 18 + pgvector | Storage and clustering in one system |
| ORM | Drizzle | Diffable migrations, which matters for agent review |
| Queue | pg-boss | Postgres-backed; no additional infrastructure |
| Tests | Vitest | |
| LLM | Anthropic SDK | Haiku 4.5 extraction, Sonnet 5 synthesis |
| Tooling | ESLint + Prettier, pnpm | |

Do not add a dependency not listed here without a task that authorizes it. Adding a
package is a decision, not an implementation detail.

### Naming collision

The project is called Fetch; `fetch` is also the Node global. The project name never
appears as a code identifier. Network access lives in `lib/net.ts` and the global is
wrapped, never called directly. Do not name a module, class, or variable `Fetch`.

### Cost envelope

Target: **under $70/month** at 50k documents ingested per month. The budget guard in
`lib/budget.ts` is a hard stop, not a warning. Any change raising projected spend above
target must be flagged in the completion report.

Model routing is a cost decision and is fixed:

- The embedding prefilter runs before every LLM call. Raw ingested documents never reach a
  model unfiltered.
- Extraction is Haiku 4.5, batch API, always.
- Synthesis is Sonnet 5, and only on clusters clearing the score threshold.
- Opus is never called from application code at runtime.

---

## 2. Agent-driven development model

Work proceeds through one **composer** and disposable **subagents**.

### Composer — Opus 5

The only agent holding the whole project in view. It:

1. Reads `SPEC.md` and `PLAN.md` at the start of every session.
2. Selects the next task whose blockers are all `DONE`. Never picks a blocked task.
3. Writes a task brief containing: task ID, exact files in scope, completion criteria
   copied verbatim from `SPEC.md`, and any interface contracts to honor.
4. Dispatches exactly one subagent per task, running independent tasks concurrently — see
   *Parallel dispatch* below.
5. Reviews the returned diff against the completion criteria. Rejects and re-dispatches
   with corrective notes if criteria are unmet. Rejection is cheap; a merged half-task
   poisons every downstream task.
6. Updates `PLAN.md` — status, changelog entry, newly discovered blockers.

The composer does not write implementation code. If the composer finds itself editing a
source file, the task was scoped wrong: stop, re-scope, dispatch.

### Subagents — Sonnet 5

Each receives one task brief and nothing else. A subagent:

- Implements exactly the task in the brief. Scope creep is a defect even when the extra
  work is obviously correct — note it in the report instead.
- Touches only files listed in the brief's scope. If a file outside scope must change,
  stop and report a blocker.
- Never edits `PLAN.md`, `SPEC.md`, or `CLAUDE.md`. Composer-owned.
- Runs `pnpm verify` before reporting. Failing checks means not complete.
- Returns a completion report in the format below.

Subagents are stateless. Assume no memory of prior tasks. Everything needed must be in the
brief or in the repo.

### Completion report format

```
TASK: <id>
STATUS: COMPLETE | BLOCKED | PARTIAL
FILES CHANGED: <list>
CRITERIA:
  - <criterion>: MET | UNMET — <one line of evidence>
VERIFY: pass | fail — <summary>
COST IMPACT: none | +$X/mo — <what changed>
NOTES: <out-of-scope observations, follow-ups, surprises>
```

`PARTIAL` is a legitimate outcome, preferred over silently expanding scope or faking a
criterion. Report honestly; the composer decides what happens next.

### Parallel dispatch

Tasks whose blockers are all `DONE` run concurrently, one subagent each. Sequential
dispatch is the exception, not the default — if two `READY` tasks do not contend, they go
out together.

Two tasks may run in parallel only when **their file scopes are disjoint**. File scope is
declared in the task brief, so the composer can check this before dispatching; if it cannot,
the brief is underspecified and the task is not ready.

- Each parallel subagent works in **its own git worktree** on its own branch off the phase
  branch. Two agents in one working tree will corrupt each other's state.
- The composer merges completed branches back into the phase branch **one at a time**,
  re-running `pnpm verify` after each merge. A merge that passes in isolation can still
  break in combination; the verify after each merge is what catches it.
- `package.json` and `pnpm-lock.yaml` are shared by every task that adds a dependency, so
  concurrent dependency-adding tasks *will* conflict. Resolve `package.json` by hand and
  regenerate the lockfile with `pnpm install` — never hand-merge a lockfile.
- Shared config files (`eslint.config.js`, `tsconfig.json`) are contention points. Two tasks
  that both amend one of them are not disjoint and must be sequenced.

Reviews parallelize freely — they are read-only and never contend.

### Escalation

A subagent escalates to the composer, rather than improvising, when it encounters: a
missing or wrong interface contract, an ambiguous completion criterion, a required
dependency not in the stack table, a change that would push spend over budget, or a
platform terms-of-service question. These are composer decisions.

---

## 3. Conventions

### Code

- TypeScript strict. No `any` — use `unknown` and narrow.
- Each module exports its types from a local `types.ts`. Do not type-import another module's
  *internals* across directories. Importing from `lib/types.ts`, from `lib/errors.ts`, or from
  another module's declared public entry point (`sources/registry.ts`, `ingest/index.ts`) is
  fine — that is the seam working as intended. The rule exists to stop modules reaching into
  each other's private structure and creating a tangle, not to forbid depending on a published
  interface.
- Source adapters implement `SourceAdapter` (`sources/types.ts`) without exception. That
  interface is the seam making future platforms cheap; never bypass it.
- All outbound network calls go through `lib/net.ts` (retry, backoff, per-host rate
  limiting). No bare `fetch` to a third-party API.
- All model calls go through `lib/llm.ts` (routing, batching, token accounting, budget
  guard). No bare Anthropic SDK calls.
- Throw typed errors from `lib/errors.ts`. Never swallow. Never `catch {}`.
- Comments explain *why* a non-obvious choice was made. Comments explaining *what* the
  code does should not exist.

### Data

- `documents` is append-only. Reprocessing writes new rows in derived tables; it never
  mutates ingested source data.
- Every derived record carries `source_document_ids` back to primary evidence. A pain
  point with no traceable evidence is a bug.
- Timestamps are `timestamptz`, UTC, always.
- Migrations are forward-only. Never edit an applied migration.

### Prompts

- Prompts live in `prompts/*.md`, never inline in TypeScript.
- Every prompt file carries a version header. Changing a prompt bumps the version.
- Every extraction and synthesis prompt has at least three golden fixtures in
  `tests/fixtures/`. Prompt changes that break golden tests must be justified in the
  completion report.

### Git

- One commit per task. Message: `<task-id>: <imperative summary>`. The commit is part of the
  task — a task reported complete without one is not complete.
- Branch per phase: `phase/<n>-<slug>`. Parallel tasks branch off it as
  `task/<task-id>-<slug>` and merge back into it.
- **One pull request per phase.** When every task in a phase is `DONE` and the final
  whole-branch review is clean, the composer pushes the phase branch and opens a PR against
  `main`. The PR body carries: the phase's task list with commit SHAs, the criteria met per
  task, cumulative cost impact, and any deferred or parked findings the review triaged as
  non-blocking. A phase is not finished until its PR is open.
- No force pushes, no rewriting shared history.

### Verification

`pnpm verify` runs typecheck, lint, unit tests, and the cost projection. It is the single
mechanical gate. Passing means the mechanical criteria are met; the composer still reviews
the semantic ones by hand.

---

## 4. Global rules

1. **Evidence or it didn't happen.** Every scored pain point traces to source URLs. Any
   feature producing unsourced output is rejected on review.
2. **Filter before you infer.** No LLM call on unfiltered data. This is the difference
   between a $20/month project and a $400/month one.
3. **The scoring rubric is the product.** Pipeline code is commodity. Time spent on dedup
   quality, recency decay, and solution-gap detection is the only thing separating Fetch
   from a Reddit search box.
4. **Respect platform terms.** Public APIs and published feeds only. No scraping behind
   authentication, no circumventing rate limits, no third-party data proxies of uncertain
   provenance. Reddit's commercial licensing requirement shut down GummySearch; assume the
   same constraints apply here and design for personal-use limits until a license exists.
5. **Store personal data minimally.** Usernames and post URLs are retained as evidence.
   Do not build user profiles, enrich identities, or resolve people across platforms. That
   is a different product with a different risk surface.
6. **Cost is a correctness property.** A pipeline that works but costs $500/month has
   failed its spec.
7. **Blocked beats broken.** Report a blocker and stop. Never improvise around a missing
   dependency, wrong interface, or ambiguous criterion.
8. **`PLAN.md` is the single source of truth for status.** If it isn't in `PLAN.md`, it
   didn't happen. The composer writes it; nobody else touches it.
