// SPEC I-05: run every configured adapter, write what they produce into the append-only
// `documents` table, dedup on `(source, source_id)`, and record what happened on a `runs`
// row. This is the last stage before ingested data is durable, so the governing rule
// throughout is that nothing may be dropped without a record of it: every source in
// `SOURCES` gets an entry in the run's counts even when it was never asked, every `partial`
// error is recorded even though its documents were written successfully, and the `runs` row
// is finalized in a `finally` so a crash still leaves a row saying so.
import { AppError, ConfigError } from '../lib/errors.js';
import { log } from '../lib/log.js';
import { withRun } from '../lib/run-context.js';
import { SOURCES, type Source } from '../lib/types.js';
import type { SourceRegistry } from '../sources/registry.js';
import type { Cursor, FetchPage, SourceAdapter } from '../sources/types.js';
import type {
  CursorStore,
  DocumentSink,
  IngestErrorRecord,
  IngestMode,
  IngestReport,
  IngestRunRecorder,
  IngestRunStatus,
  IngestStopReason,
  IngestTotals,
  SourceIngestCounts,
  SourceRunStatus,
} from './types.js';

export const INGEST_STAGE = 'ingest';

/**
 * Backstop on how many pages one source may walk in a single run. This bounds the *cost* of
 * a runaway loop; it does not detect one — that is `runSource`'s no-progress rule below.
 * Both exist because they fail differently: the rule catches a source that is genuinely
 * making no progress, the bound catches anything the rule does not anticipate.
 *
 * 25 rather than something larger because a source that legitimately needs more than 25
 * pages to catch up will simply resume from its persisted cursor on the next run, whereas a
 * source that is quietly paging forever burns a third party's rate limit for as long as it
 * takes someone to notice.
 */
export const DEFAULT_MAX_PAGES_PER_RUN = 25;

export interface RunIngestOptions {
  readonly registry: SourceRegistry;
  readonly documents: DocumentSink;
  readonly cursors: CursorStore;
  readonly runs: IngestRunRecorder;
  /** Defaults to `{ kind: 'incremental' }`. */
  readonly mode?: IngestMode;
  readonly maxPagesPerRun?: number;
  /** Injected clock, mirroring lib/net.ts's own DI seam, so duration assertions are deterministic. */
  readonly now?: () => Date;
}

interface SourceRunOutcome {
  readonly counts: SourceIngestCounts;
  readonly errors: readonly IngestErrorRecord[];
}

function toErrorRecord(
  source: Source | null,
  kind: IngestErrorRecord['kind'],
  err: unknown,
): IngestErrorRecord {
  if (err instanceof AppError) {
    return {
      source,
      kind,
      name: err.name,
      code: err.code,
      message: err.message,
      context: err.context,
    };
  }
  if (err instanceof Error) {
    // An adapter throwing a non-`AppError` is a bug in that adapter (CLAUDE.md: throw typed
    // errors) — recorded as faithfully as the taxonomy allows rather than reclassified into
    // it, since inventing a `code` here would misreport where the error came from.
    return {
      source,
      kind,
      name: err.name,
      code: undefined,
      message: err.message,
      context: undefined,
    };
  }
  return {
    source,
    kind,
    name: 'UnknownThrownValue',
    code: undefined,
    message: String(err),
    context: undefined,
  };
}

async function fetchOnePage(
  adapter: SourceAdapter,
  mode: IngestMode,
  cursor: Cursor | undefined,
): Promise<FetchPage> {
  return mode.kind === 'incremental'
    ? adapter.fetchIncremental(cursor)
    : adapter.fetchBackfill(mode.range, cursor);
}

async function runSource(
  source: Source,
  adapter: SourceAdapter,
  options: Required<
    Pick<RunIngestOptions, 'documents' | 'cursors' | 'mode' | 'maxPagesPerRun' | 'now'>
  >,
): Promise<SourceRunOutcome> {
  const { documents, cursors, mode, maxPagesPerRun, now } = options;
  const startedAt = now();
  const errors: IngestErrorRecord[] = [];
  const truncatedReasons: string[] = [];
  let fetched = 0;
  let inserted = 0;
  // Counted from what the sink actually reported, never derived as `fetched - inserted`.
  // Fix round 1, Finding 3: a page whose insert throws has already been counted in
  // `fetched`, so the subtraction reported its documents as duplicates — rows that were
  // never written and are not present. `runs` rows are what an operator reads to work out
  // what happened, so the invariant is `inserted + duplicates <= fetched`, and any shortfall
  // is documents whose write did not complete (the accompanying error says why).
  let duplicates = 0;
  let pages = 0;
  let sawPartial = false;
  let stopReason: IngestStopReason = 'page-limit';
  let status: SourceRunStatus = 'complete';

  const finish = (): SourceRunOutcome => {
    const durationMs = now().getTime() - startedAt.getTime();
    return {
      counts: {
        source,
        status,
        fetched,
        inserted,
        duplicates,
        pages,
        durationMs,
        stopReason,
        truncatedReasons,
      },
      errors,
    };
  };

  let cursor: Cursor | undefined =
    mode.kind === 'incremental' ? await cursors.get(source) : undefined;

  try {
    // `checkHealth` never throws *by contract* (I-01 resolution 5) — it reports as data, so
    // it gets no try/catch of its own, which would imply the contract is untrusted. It does
    // sit inside this source's error boundary, though. Fix round 1, Finding 1: all three
    // adapters catch `AppError` and rethrow anything else, so a plain bug in a health probe
    // (a `TypeError`, say) escaped from here and aborted every *other* source — the same bug
    // class is contained when it happens in `fetchIncremental`, and criterion 2 does not
    // distinguish which method an adapter fails in.
    const health = await adapter.checkHealth();
    if (!health.healthy) {
      status = 'unhealthy';
      stopReason = 'not-attempted';
      errors.push({
        source,
        kind: 'unhealthy',
        name: 'UnhealthySource',
        code: 'SOURCE_UNHEALTHY',
        message: health.detail,
        context: undefined,
      });
      log.warn('source reported unhealthy; skipping its fetch', { source, detail: health.detail });
      const outcome = finish();
      return { counts: { ...outcome.counts, detail: health.detail }, errors: outcome.errors };
    }

    while (pages < maxPagesPerRun) {
      const page = await fetchOnePage(adapter, mode, cursor);
      pages += 1;
      const offered = page.documents.length;
      fetched += offered;
      // Written before any outcome branching: a `partial` page's documents are good
      // documents that happen to have arrived alongside an error, and the salvage the
      // adapters perform is pointless if this stage drops them on the way past.
      const insertedNow = await documents.insert(page.documents);
      inserted += insertedNow;
      duplicates += offered - insertedNow;

      const outcome = page.outcome;
      if (outcome !== undefined) {
        if (outcome.kind === 'truncated') {
          // Not a failure and explicitly not a reason to mark the run PARTIAL (composer
          // resolution 4): a structural ceiling the adapter can never page past is a
          // standing fact about coverage, recorded so a human can eventually notice it.
          truncatedReasons.push(outcome.reason);
          log.info('source reported truncated coverage', { source, reason: outcome.reason });
        } else {
          sawPartial = true;
          errors.push(toErrorRecord(source, 'partial', outcome.error));
          if (outcome.truncatedReason !== undefined) {
            // `partial` decides the disposition; `truncatedReason` rides along as an
            // independent fact about an *earlier* unit of the same fan-out. Recording only
            // one of the two would drop whichever was not chosen.
            truncatedReasons.push(outcome.truncatedReason);
          }
          log.warn('source returned a partial page', { source, error: outcome.error });
        }
      }

      const next = page.cursor;

      // The stall predicate (composer resolution 3), checked before anything else can
      // interpret the cursor: an adapter that hands back the cursor it was given *and*
      // reports `partial` has re-attempted a page and failed the same way, deliberately, so
      // the failure is re-tried rather than skipped. Halt — do not recover. Cursors are
      // opaque (I-01 resolution 3), so there is no way to construct a "next" one and skip
      // ahead; halting loudly is the only honest disposition, and inventing progress here
      // would silently abandon whatever that page holds.
      //
      // `next !== undefined` is part of the predicate, not an oversight. "Identical to the
      // cursor passed in" describes a *token handed back*; undefined-in/undefined-out is the
      // absence of one on both sides, which is a different thing. The Hacker News adapter
      // returns `cursor: undefined` on every `partial` by design ("the next call simply
      // replays the same starting boundary from scratch"), so treating that as a stall would
      // brand every first-run transient failure — before any cursor has ever been stored —
      // as a permanently stalled source. It also cannot loop: `next === undefined` exits
      // below regardless, which is the only thing halting would have achieved.
      //
      // This check is not redundant with the no-progress rule below even though both stop
      // the loop on the same condition. The difference is what gets recorded: without this,
      // a permanently wedged source reports as a routine `partial` that happened to stop
      // early, and nothing on the run row says it is stuck. Deleting it would cost no
      // termination and all of the visibility.
      if (next !== undefined && next === cursor && outcome?.kind === 'partial') {
        status = 'stalled';
        stopReason = 'stalled';
        errors.push({
          source,
          kind: 'stalled',
          name: 'StalledSource',
          code: 'SOURCE_STALLED',
          message: `Source "${source}" returned the same cursor it was given alongside a partial outcome — it is re-attempting a page it cannot get past. Halted after ${pages} page(s).`,
          context: { pages },
        });
        log.error('source stalled; halting it for this run', { source, pages });
        return finish();
      }

      if (next === undefined) {
        stopReason = 'exhausted';
        break;
      }

      if (next === cursor) {
        // Same cursor, no error: calling again would reproduce this page exactly, so there
        // is nothing further to do. This is the ordinary terminator for an adapter whose
        // incremental fetch never returns `cursor: undefined` — the App Store adapter always
        // encodes its per-pair high-water state — and without it such a source would page to
        // `maxPagesPerRun` on every single run.
        //
        // Fix round 1, Finding 4: the emptiness of the page is deliberately *not* part of
        // this predicate. Terminating is correct either way — a repeated call with a
        // repeated cursor is a repeated page — and there is no skip risk, because the cursor
        // is never advanced and the next run replays from the same position. Requiring an
        // empty page instead would leave an adapter in the documents-returning shape walking
        // to `maxPagesPerRun` against a live upstream on every single run: trading a quiet,
        // correct stop for a loud, expensive one.
        //
        // It does get its own stop reason rather than being folded into the ordinary case.
        // Handing back documents while claiming no new position is an adapter contract
        // anomaly with no `partial` to explain it, and "caught up" is the wrong story to
        // tell about it on the run row. It stays `status: 'complete'` with no error entry —
        // nothing failed and nothing was skipped — so the disposition is unchanged and only
        // the diagnosis differs.
        if (offered > 0) {
          stopReason = 'no-progress-with-documents';
          log.warn('source returned documents with an unchanged cursor; it cannot advance', {
            source,
            documents: offered,
            pages,
          });
        } else {
          stopReason = 'no-progress';
        }
        break;
      }

      // Persisted per page, not once at the end: a run that dies on page 4 keeps the ground
      // pages 1-3 covered instead of re-walking it. Only ever an advance, never a clear —
      // `CursorStore` has no delete for the reason its doc comment gives.
      if (mode.kind === 'incremental') {
        await cursors.set(source, next);
      }
      cursor = next;
    }
  } catch (err) {
    // One adapter failing must not abort the others (SPEC I-05 criterion 2), so every error
    // out of a source is contained here — recorded on the run, logged at error level, and
    // the loop moves to the next source. This is containment, not swallowing: the error
    // reaches both `runs.errors` and the log, and it forces the run's status to PARTIAL.
    status = 'failed';
    stopReason = 'error';
    errors.push(toErrorRecord(source, 'thrown', err));
    log.error('source failed; continuing with the remaining sources', { source, error: err });
    return finish();
  }

  if (sawPartial) {
    status = 'partial';
  }
  if (stopReason === 'page-limit') {
    log.warn('source hit the per-run page limit; it will resume from its cursor next run', {
      source,
      pages,
      maxPagesPerRun,
    });
  }
  return finish();
}

/**
 * `COMPLETE` only when every source that was actually asked ran clean. `FAILED` when sources
 * were asked and *none* of them produced a usable result. `PARTIAL` for everything between —
 * which is the value SPEC I-05 criterion 2 names for "one adapter failing does not abort the
 * others". A run whose sources are all skipped is `COMPLETE`: nothing was asked, so nothing
 * failed, and the counts say so source by source.
 */
function computeRunStatus(counts: readonly SourceIngestCounts[]): IngestRunStatus {
  // Both `skipped` and `not-attempted` are excluded: neither says anything about whether the
  // source works, so counting either as a failure would make an unconfigured source look
  // broken and a run that died early look like three broken sources.
  const attempted = counts.filter(
    (entry) => entry.status !== 'skipped' && entry.status !== 'not-attempted',
  );
  if (attempted.length === 0) {
    return 'COMPLETE';
  }
  const usable = attempted.filter(
    (entry) => entry.status === 'complete' || entry.status === 'partial',
  );
  if (usable.length === 0) {
    return 'FAILED';
  }
  return attempted.every((entry) => entry.status === 'complete') ? 'COMPLETE' : 'PARTIAL';
}

/**
 * The placeholder every source starts the run holding (fix round 1, Finding 2). Seeding
 * these up front is what makes the file header's invariant — every source in `SOURCES` gets
 * an entry, even one that was never asked — true on the run-level failure path too, not just
 * on the paths that reach the end of the loop. Before this, a run that threw partway wrote a
 * `bySource` naming only the sources it had already reached, which is the least useful moment
 * to be missing them: an operator reading a `FAILED` row cannot tell "this source ran and
 * found nothing" from "the run died before getting to it".
 *
 * Distinct from `'skipped'`, which means deliberately configured off. This means the run
 * ended first, which is not a statement about the source at all.
 */
function notAttemptedCounts(source: Source): SourceIngestCounts {
  return {
    source,
    status: 'not-attempted',
    fetched: 0,
    inserted: 0,
    duplicates: 0,
    pages: 0,
    durationMs: 0,
    stopReason: 'not-attempted',
    truncatedReasons: [],
    detail: 'The run ended before this source was reached',
  };
}

function sumTotals(counts: readonly SourceIngestCounts[]): IngestTotals {
  return counts.reduce<IngestTotals>(
    (acc, entry) => ({
      fetched: acc.fetched + entry.fetched,
      inserted: acc.inserted + entry.inserted,
      duplicates: acc.duplicates + entry.duplicates,
    }),
    { fetched: 0, inserted: 0, duplicates: 0 },
  );
}

/**
 * Runs every registered adapter in turn and returns what happened. Always writes a `runs`
 * row — including when the run itself fails, which is finalized in a `finally` before the
 * error propagates.
 *
 * Sources run sequentially rather than concurrently: lib/net.ts's rate limiting is per host,
 * so three adapters in flight at once do not contend, but the `documents` writes and the
 * per-source cursor writes would interleave on one connection pool for no gain that this
 * pipeline's volumes justify. Nothing about the design forbids parallelising it later.
 */
export async function runIngest(options: RunIngestOptions): Promise<IngestReport> {
  const now = options.now ?? (() => new Date());
  const mode: IngestMode = options.mode ?? { kind: 'incremental' };
  const maxPagesPerRun = options.maxPagesPerRun ?? DEFAULT_MAX_PAGES_PER_RUN;
  const { registry, documents, cursors, runs } = options;

  // Fix round 1, Finding 6: rejected before the run row is inserted, because a run that
  // cannot fetch a single page never began. `0` is the dangerous value and is reachable from
  // a caller that computes this — it made every source report `complete` with `page-limit`,
  // zero documents and zero errors, which is a silent no-op wearing a success's clothes.
  // Non-integers are rejected in the same breath: `2.5` silently means two pages, and a
  // bound nobody can predict from its own value is not a bound.
  if (!Number.isInteger(maxPagesPerRun) || maxPagesPerRun < 1) {
    throw new ConfigError(
      `maxPagesPerRun must be an integer of at least 1, received ${String(maxPagesPerRun)} — a run that may walk zero pages would report success having fetched nothing`,
      { context: { maxPagesPerRun } },
    );
  }

  const startedAt = now();
  const runId = await runs.start(INGEST_STAGE);

  return withRun(runId, async () => {
    // Seeded with every source up front (see `notAttemptedCounts`) and replaced in place as
    // each one resolves. A `Map` keyed by source keeps `SOURCES` order across replacement,
    // so the run row lists every source in a stable order however the run ends.
    const counts = new Map<Source, SourceIngestCounts>(
      SOURCES.map((source) => [source, notAttemptedCounts(source)]),
    );
    const orderedCounts = (): SourceIngestCounts[] => [...counts.values()];
    const errors: IngestErrorRecord[] = [];
    let status: IngestRunStatus = 'FAILED';
    let failure: unknown;
    let failed = false;
    // Read once, in the `finally`, and reused by the report below: two `now()` calls would
    // give the run row and the returned report two different end times under an injected
    // clock, and the two are supposed to describe the same run.
    let finishedAt = startedAt;

    try {
      const registered = new Set(registry.list());
      const skipReasons = new Map(registry.skipped().map((entry) => [entry.source, entry.reason]));

      // Iterated over `SOURCES`, not over `registry.list()`, so the run's counts name every
      // source that exists — a source missing from the registry shows up as `skipped` with a
      // reason rather than as an absence nobody can distinguish from "ran and found nothing".
      for (const source of SOURCES) {
        if (!registered.has(source)) {
          const reason =
            skipReasons.get(source) ??
            'No adapter registered for this source and no reason recorded — check the registry wiring';
          counts.set(source, {
            source,
            status: 'skipped',
            fetched: 0,
            inserted: 0,
            duplicates: 0,
            pages: 0,
            durationMs: 0,
            stopReason: 'not-attempted',
            truncatedReasons: [],
            detail: reason,
          });
          log.info('source skipped: not configured', { source, reason });
          continue;
        }

        const outcome = await runSource(source, registry.get(source), {
          documents,
          cursors,
          mode,
          maxPagesPerRun,
          now,
        });
        counts.set(source, outcome.counts);
        errors.push(...outcome.errors);
      }

      status = computeRunStatus(orderedCounts());
    } catch (err) {
      // Reached only for something outside any single source's boundary — `runSource`
      // contains adapter failures itself. The row still gets written by the `finally` below
      // before this propagates, which is the whole point of finalizing there.
      failed = true;
      failure = err;
      status = 'FAILED';
      errors.push(toErrorRecord(null, 'run', err));
      throw err;
    } finally {
      finishedAt = now();
      const finalCounts = orderedCounts();
      const totals = sumTotals(finalCounts);
      try {
        await runs.finish(runId, {
          status,
          finishedAt,
          counts: {
            bySource: Object.fromEntries(finalCounts.map((entry) => [entry.source, entry])),
            totals,
            durationMs: finishedAt.getTime() - startedAt.getTime(),
          },
          errors,
        });
      } catch (finishErr) {
        // If nothing else was wrong, a run row that could not be written *is* the failure and
        // must surface. If the run was already failing, replacing its error with this one
        // would hide the original cause, so it is logged at error level (never dropped) and
        // the original propagates.
        if (!failed) {
          throw finishErr;
        }
        log.error('ingest run row could not be finalized; the original failure follows', {
          run_id: runId,
          error: finishErr,
          original: failure,
        });
      }
    }

    const reportCounts = orderedCounts();
    const report: IngestReport = {
      runId,
      status,
      startedAt,
      finishedAt,
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      counts: reportCounts,
      errors,
      totals: sumTotals(reportCounts),
    };
    log.info('ingest run complete', {
      run_id: runId,
      status,
      totals: report.totals,
      durationMs: report.durationMs,
      errorCount: errors.length,
    });
    return report;
  });
}
