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
**Next up:** F-01
**Rolling 30-day projected spend:** $0.00 (ceiling: $70.00)

---

## Task tracker

### Phase 0 — Foundation

| ID | Task | Status | Blockers | Assigned | Notes |
|---|---|---|---|---|---|
| F-01 | Repo scaffold and tooling | READY | — | — | |
| F-02 | Database schema and migrations | TODO | F-01 | — | |
| F-03 | Config and secrets | TODO | F-01 | — | |
| F-04 | `lib/net.ts` | TODO | F-01, F-03 | — | Gates all of Phase 1 |
| F-05 | `lib/llm.ts` + `lib/budget.ts` | TODO | F-01, F-03 | — | Gates all of Phase 2 |
| F-06 | Error taxonomy and logging | TODO | F-01 | — | |

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

### — Project initialized
**Summary:** `CLAUDE.md`, `SPEC.md`, and `PLAN.md` created. Phase 0 open, F-01 `READY`.
**Files:** CLAUDE.md, SPEC.md, PLAN.md
**Criteria:** n/a
**Cost impact:** none
**Follow-ups:** Three human-input blockers (B-01, B-02, B-03) registered. Labeling work
should begin in parallel with Phase 0 rather than blocking Phase 2 later.
