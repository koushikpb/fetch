# SPEC.md

Phase and task definitions for **Fetch**. The composer reads this file to select and brief
tasks. Completion criteria are copied verbatim into task briefs — they are contracts, not
suggestions.

**Task ID format:** `<PHASE-LETTER>-<NN>`. Blockers list task IDs that must be `DONE`
first. A task with no blockers listed is startable immediately once its phase opens.

**Definition of done, universal:** all listed criteria met, `pnpm verify` passes, one
commit made, completion report returned. These are assumed for every task and not repeated
below.

---

## Phase 0 — Foundation (`F`)

Establishes the seams every later phase depends on. Nothing in Phase 1+ may start until
`F-04` and `F-05` are `DONE`, because those two files are where all network and model
access is centralized. Getting them wrong late is expensive.

### F-01 — Repo scaffold and tooling
Blockers: none
Initialize pnpm workspace, TypeScript strict config, ESLint, Prettier, Vitest, Node 22
engine pin, directory skeleton matching the architecture in `CLAUDE.md`, and the `verify`
script (typecheck + lint + test; cost projection is stubbed until `O-04`).

Criteria:
- `pnpm install && pnpm verify` succeeds on a clean checkout.
- Every architecture directory exists with a placeholder `types.ts`.
- `tsconfig.json` has `strict: true` and `noUncheckedIndexedAccess: true`.
- ESLint fails the build on `any`, on bare `fetch`, and on direct `@anthropic-ai/sdk`
  imports outside `lib/llm.ts`.

### F-02 — Database schema and migrations
Blockers: F-01
Drizzle schema and initial migration. Tables: `documents` (append-only, unique on
`(source, source_id)`), `embeddings`, `pain_points`, `clusters`, `cluster_members`,
`scores`, `briefs`, `runs`. Enable pgvector.

Criteria:
- Migration applies cleanly to an empty Postgres 16 database and rolls forward only.
- `documents` has a unique constraint on `(source, source_id)` and no `UPDATE` path in
  the codebase.
- Every derived table has a non-null `source_document_ids` array or a foreign key chain
  reaching one.
- All timestamps are `timestamptz`.
- A seed script inserts 20 fixture documents across all three sources.

### F-03 — Config and secrets
Blockers: F-01
Typed config loader with schema validation at boot. Fails fast and loudly on missing or
malformed values. `.env.example` documents every variable.

Criteria:
- Boot with a missing required variable exits non-zero with a message naming the variable.
- No `process.env` access anywhere outside the config module.
- Secrets never appear in logs, error messages, or stack traces.

### F-04 — `lib/net.ts`
Blockers: F-01, F-03
Single outbound HTTP path. Exponential backoff with jitter, per-host token-bucket rate
limiting, timeouts, typed errors, structured request logging.

Criteria:
- Per-host rate limits are configurable and enforced; Reddit defaults to 100 QPM.
- Retries only on 429, 5xx, and network errors. Never on 4xx other than 429.
- Respects `Retry-After` when present.
- Tests cover: backoff timing, rate-limit enforcement, `Retry-After` handling, timeout.
- No bare `fetch` call exists anywhere else in the repo.

### F-05 — `lib/llm.ts` and `lib/budget.ts`
Blockers: F-01, F-03
Single model-access path. Model routing, batch API submission and polling, token
accounting persisted per run, and a hard budget guard.

Criteria:
- Exposes exactly two routes: `extract()` → Haiku 4.5 batch, `synthesize()` → Sonnet 5.
- No code path can invoke an Opus model; attempting to throws.
- Every call records input tokens, output tokens, model, and computed cost to `runs`.
- Budget guard throws `BudgetExceededError` before dispatching a call that would push the
  rolling 30-day projection past the configured ceiling.
- Tests cover: routing, batch submit/poll/retrieve, token accounting math, budget refusal.

### F-06 — Error taxonomy and logging
Blockers: F-01
`lib/errors.ts` with typed error classes. Structured JSON logging with a run correlation
ID threaded through every stage.

Criteria:
- Every thrown error in the repo is an instance of a class from `lib/errors.ts`.
- No `catch {}` or bare rethrow-and-swallow exists.
- Logs are single-line JSON and always include `run_id` when inside a run.

---

## Phase 1 — Ingestion (`I`)

Three adapters against a shared interface. The interface lands first because getting it
right is what makes the fourth and fifth sources cheap later.

### I-01 — `SourceAdapter` interface and registry
Blockers: F-04, F-06
Define the interface, the normalized `Document` shape, and a registry mapping source names
to adapter instances.

Criteria:
- Interface covers: incremental fetch by cursor, backfill by date range, health check.
- Normalized `Document` includes: source, source_id, url, author_handle, title, body,
  created_at, engagement metrics, raw payload.
- Registry is the only way to obtain an adapter; adapters are never imported directly by
  ingest code.
- A no-op fake adapter exists for tests.

### I-02 — Hacker News adapter
Blockers: I-01
Algolia search API for discovery, Firebase API for item hydration. Free and unmetered —
this is the source to develop against.

Criteria:
- Fetches stories and comments matching configured queries, with cursor-based incremental
  runs that do not re-fetch on a second consecutive run.
- Health check passes against the live API.
- Handles deleted and dead items without throwing.
- Integration test against recorded fixtures, not live network.

### I-03 — App Store reviews adapter
Blockers: I-01
iTunes RSS review feeds by app ID and territory. One-star and two-star reviews carry the
densest signal; the adapter must preserve rating.

Criteria:
- Fetches reviews for a configured app-ID list across configured territories.
- `rating` is preserved on the normalized `Document`.
- Handles the RSS feed's 500-review pagination ceiling and records truncation on the run.
- Integration test against recorded fixtures.

### I-04 — Reddit adapter
Blockers: I-01
OAuth against the free tier, 100 QPM. Configured subreddit list, new and top listings,
comment expansion on qualifying threads.

Criteria:
- OAuth token refresh handled transparently; expiry mid-run does not fail the run.
- Never exceeds 100 QPM, enforced through `lib/net.ts`.
- Comment expansion is bounded by a configurable depth and breadth limit.
- Records rate-limit headroom on each run for later capacity planning.
- Integration test against recorded fixtures.

### I-05 — Ingest orchestrator
Blockers: I-02, I-03, I-04
Runs adapters, writes to `documents`, dedups on `(source, source_id)`, records run
metadata.

Criteria:
- Re-running immediately inserts zero new rows.
- One adapter failing does not abort the others; partial runs are recorded as `PARTIAL`.
- Every run writes a `runs` row with counts per source, duration, and errors.

### I-06 — Scheduling
Blockers: I-05
pg-boss job definitions and schedules for each adapter.

Criteria:
- Schedules are configuration, not code.
- Overlapping runs of the same source are prevented by a job-level lock.
- A failed job retries with backoff and gives up after a configurable count.

---

## Phase 2 — Filter and extract (`X`)

The cost-critical phase. Rule 2 in `CLAUDE.md` lives or dies here.

### X-01 — Embedding pipeline
Blockers: F-05, I-05
Embed documents, store vectors in `embeddings`, index with pgvector.

Criteria:
- Embeddings are batched and idempotent; re-running embeds zero already-embedded docs.
- Vector index exists and is used by the query planner (verified via `EXPLAIN` in a test).
- Cost per 1k documents embedded is recorded and asserted under a configured ceiling.

### X-02 — Unmet-need prefilter
Blockers: X-01
Classify documents as candidate or noise using embedding similarity to a curated seed set
of unmet-need language, plus cheap lexical signals. **No LLM call in this task.**

Criteria:
- Achieves ≥90% noise rejection on the labeled evaluation set in `tests/fixtures/filter/`.
- Recall on labeled true positives is ≥85%. Precision matters less than recall here —
  a missed opportunity is invisible, a false positive costs one Haiku call.
- Threshold is configurable and its effect on the eval set is reported by a test.
- Zero LLM calls occur during filtering, asserted by test.

### X-03 — Extraction prompt and fixtures
Blockers: F-05
`prompts/extract.md` with a version header, plus at least three golden fixtures per source
in `tests/fixtures/extract/`.

Criteria:
- Prompt returns strict JSON matching the `PainPoint` schema; no prose, no fences.
- Extracted fields include: problem statement, domain, intensity signal, workarounds
  mentioned, existing tools mentioned, quoted evidence spans.
- Golden tests pass against recorded model responses.
- Prompt refuses to invent a pain point when the document contains none, returning an
  empty array. Fixture coverage includes at least one such document.

### X-04 — Batch extraction worker
Blockers: X-02, X-03
Submits candidate documents to the Haiku 4.5 batch API, polls, parses, persists to
`pain_points`.

Criteria:
- Only documents passing the prefilter are submitted, asserted by test.
- Batch submission, polling, and retrieval survive process restart mid-run.
- Malformed model output is quarantined with the raw response retained, not silently
  dropped, and does not fail the batch.
- Every persisted `pain_point` carries `source_document_ids`.

---

## Phase 3 — Cluster and score (`C`)

Rule 3: this phase is the product. Budget the most review time here.

### C-01 — Clustering
Blockers: X-04
Agglomerative clustering over pain-point embeddings, into `clusters` and
`cluster_members`.

Criteria:
- Produces stable cluster assignments across two runs on identical input.
- Cluster count and distance threshold are configurable.
- Every cluster exposes its member pain points and, transitively, source documents.
- Evaluated against the hand-labeled cluster set in `tests/fixtures/cluster/`.

### C-02 — Cross-source dedup
Blockers: C-01
The same complaint from Reddit, HN, and an App Store review is one opportunity, not three.

Criteria:
- Near-duplicate pain points across sources merge into one cluster on the labeled set.
- Merged clusters retain evidence from all contributing sources.
- Source diversity is recorded per cluster — a cluster appearing in three sources is a
  stronger signal than one appearing thirty times in one subreddit, and downstream scoring
  needs that distinction available.

### C-03 — Scoring rubric
Blockers: C-02
Compute frequency, intensity, recency decay, and source diversity into a composite score.

Criteria:
- Recency decay is explicit and configurable; a complaint cluster with no activity in 180
  days scores materially lower than an equally sized recent one.
- Component scores are persisted individually, not just the composite. Debugging a bad
  ranking requires seeing which term caused it.
- Weights are configuration, not code.
- Scoring is deterministic and unit-tested against fixtures with known expected ordering.

### C-04 — Solution-gap detection
Blockers: C-03
Determine whether an adequate solution already exists. This is the differentiator; a
cluster with ten mature solutions is not an opportunity regardless of complaint volume.

Criteria:
- Extracts tools and products named in the cluster's own evidence and weights their
  presence against the cluster.
- Distinguishes "no solution mentioned" from "solutions mentioned and criticized" from
  "solutions mentioned approvingly" — the middle case is the valuable one.
- Gap score is persisted separately and is a distinct term in the composite.
- Validated against the labeled set in `tests/fixtures/gap/`, including at least five
  known-saturated clusters that must score low.

### C-05 — Calibration harness
Blockers: C-04
A repeatable way to evaluate ranking quality against a human-labeled set.

Criteria:
- Emits precision@10 and NDCG against the labeled set.
- Runs in `pnpm verify` and fails the build on regression beyond a configured tolerance.
- Weight changes produce a printed before/after comparison.

---

## Phase 4 — Synthesis (`S`)

### S-01 — Synthesis prompt and fixtures
Blockers: C-05
`prompts/synthesize.md`, versioned, with golden fixtures.

Criteria:
- Output is a structured brief: problem, who has it, evidence of intensity, existing
  solutions and their gaps, why now, and what a minimal product would be.
- Every factual claim in a brief maps to a quoted evidence span from cluster members.
- Prompt declines to produce a brief when evidence is too thin, returning a reason.

### S-02 — Brief generator
Blockers: S-01
Sonnet 5 synthesis over qualifying clusters, persisted to `briefs`.

Criteria:
- Runs only on clusters above the configured score threshold, asserted by test.
- Cost per brief is recorded; projected monthly synthesis spend stays within envelope.
- Regenerating a brief supersedes rather than overwrites, retaining history.

### S-03 — Citation integrity check
Blockers: S-02
Automated verification that briefs do not contain unsourced claims.

Criteria:
- Every quoted span in a brief is verified to exist verbatim in a linked source document.
- A brief failing verification is flagged and withheld from the UI, not published.
- Test includes a deliberately fabricated brief that must be caught.

---

## Phase 5 — Interface (`W`)

### W-01 — App shell
Blockers: F-02
Next.js 15 App Router shell, local-only, no auth in v1.

Criteria:
- Builds and serves; reads from the same Postgres instance as the pipeline.
- No client-side secret exposure; server components handle all data access.

### W-02 — Ranked opportunity table
Blockers: W-01, C-05
Sortable, filterable table of scored clusters.

Criteria:
- Sortable by composite and by each component score independently.
- Filterable by source, domain, date range, and gap score.
- Renders 500 clusters without pagination stalls.

### W-03 — Brief detail and evidence drill-down
Blockers: W-02, S-03
Full brief with expandable evidence trail to original posts.

Criteria:
- Every claim links to the source document and out to the original URL.
- Component score breakdown is visible, not just the composite.
- Briefs failing citation integrity are visibly marked and not silently shown as valid.

### W-04 — Run history
Blockers: W-01, I-06
Visibility into runs, per-stage counts, spend, and failures.

Criteria:
- Shows documents ingested, filtered, extracted, clustered, and synthesized per run.
- Shows token spend per run and rolling 30-day projection against the ceiling.

---

## Phase 6 — Operations (`O`)

### O-01 — Budget enforcement end to end
Blockers: F-05, S-02
Wire the budget guard into every stage and alert on approach.

Criteria:
- Exceeding the ceiling halts new model dispatch and records the halt, without corrupting
  in-flight batches.
- A warning fires at a configurable fraction of ceiling.

### O-02 — Observability
Blockers: F-06, I-06
Per-stage metrics, structured run logs, failure surfacing.

Criteria:
- Every stage emits duration, input count, output count, and error count.
- A failed run is discoverable without reading raw logs.

### O-03 — Cost projection in verify
Blockers: O-01
Replace the `F-01` stub with a real projection.

Criteria:
- `pnpm verify` prints projected monthly cost from current configuration and volumes.
- Fails the build if projection exceeds the configured ceiling.

---

## Phase 7 — Extensions (`E`)

Deferred. Do not start without an explicit composer decision recorded in `PLAN.md`.

### E-01 — X adapter behind a flag
Blockers: I-01, O-03
Gated by cost review. At $0.005 per post read, 50k posts is $250/month — roughly four
times the rest of the system combined. Requires an explicit budget-ceiling increase.

### E-02 — Review-site adapter
Blockers: I-01
G2, Capterra, or similar. Requires a terms-of-service review before implementation
begins; no scraping behind authentication.

### E-03 — Export
Blockers: W-03
CSV and Markdown export of briefs with evidence links intact.
