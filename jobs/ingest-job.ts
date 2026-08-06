// What one scheduled tick actually does: run I-05's orchestrator for exactly one source, and
// decide from the report whether pg-boss should treat the job as done or retry it.
//
// The retry decision is the whole substance of this file, and it is made against the
// vocabulary I-05 established rather than against a bare pass/fail. A policy that treated
// `PARTIAL` as failure would re-run a source that did produce documents; one that treated
// `FAILED` as success would leave a dead pipeline looking healthy.
import { runIngest } from '../ingest/index.js';
import { AppError } from '../lib/errors.js';
import { log } from '../lib/log.js';
import { SOURCES, type Source } from '../lib/types.js';
import {
  createSourceRegistry,
  type SkippedSource,
  type SourceRegistry,
} from '../sources/registry.js';
import type { SourceAdapter } from '../sources/types.js';
import { ingestQueueName } from './queues.js';
import type { IngestJobContext, IngestJobResult } from './types.js';

/**
 * Narrows the production registry to a single source, expressed the only way the orchestrator
 * understands it: every other source is `skipped`, with a reason, so the run's `runs` row
 * still accounts for all three rather than appearing to have forgotten two of them.
 *
 * A source the full registry itself left out — Reddit without credentials (blocker B-09) —
 * keeps its own skip reason and produces a registry with no adapters at all. That is
 * deliberately not a special case downstream: the orchestrator scores a run in which nothing
 * was attempted as `COMPLETE`, so the job succeeds, is never retried, and still leaves a
 * `runs` row naming the source and saying why it did not run.
 */
export function restrictRegistryToSource(registry: SourceRegistry, source: Source): SourceRegistry {
  const registered = new Set(registry.list());
  const skipReasons = new Map(registry.skipped().map((entry) => [entry.source, entry.reason]));
  const adapters: SourceAdapter[] = [];
  const skipped: SkippedSource[] = [];

  for (const candidate of SOURCES) {
    if (candidate === source) {
      if (registered.has(candidate)) {
        adapters.push(registry.get(candidate));
      } else {
        skipped.push({
          source: candidate,
          reason:
            skipReasons.get(candidate) ??
            `No adapter registered for source "${candidate}" and no reason recorded — check the registry wiring`,
        });
      }
      continue;
    }
    skipped.push({
      source: candidate,
      reason: `Not this job's source — "${candidate}" runs on its own schedule via queue ${ingestQueueName(candidate)}`,
    });
  }

  return createSourceRegistry(adapters, skipped);
}

/**
 * Runs one source and returns what happened. Throws — which is how a pg-boss handler asks
 * for a retry — only when the run came back `FAILED`, meaning this source was attempted and
 * produced nothing usable.
 */
export async function runIngestJob(
  source: Source,
  context: IngestJobContext,
): Promise<IngestJobResult> {
  const report = await runIngest({
    registry: restrictRegistryToSource(context.registry, source),
    documents: context.documents,
    cursors: context.cursors,
    runs: context.runs,
  });

  const counts = report.counts.find((entry) => entry.source === source);
  if (counts === undefined) {
    // The orchestrator seeds an entry for every source in `SOURCES` before it runs anything,
    // so this is unreachable unless that contract changes. Surfaced rather than defaulted:
    // inventing a disposition here would make a broken contract look like a healthy run.
    throw new AppError(
      'INGEST_REPORT_MISSING_SOURCE',
      `Ingest report for run ${report.runId} has no entry for source "${source}"`,
      { context: { source, runId: report.runId, status: report.status } },
    );
  }

  const result: IngestJobResult = {
    source,
    runId: report.runId,
    status: report.status,
    sourceStatus: counts.status,
    stopReason: counts.stopReason,
    totals: report.totals,
  };

  if (counts.status === 'skipped') {
    // Composer resolution 6: configured off is a first-class outcome, not an error. Returning
    // normally is what keeps Reddit's absence from turning every scheduled cycle red.
    log.info('scheduled ingest skipped a source that is configured off', {
      source,
      run_id: report.runId,
      reason: counts.detail,
    });
    return result;
  }

  // I-05 records this on the run row and logs a warning, but deliberately puts nothing in
  // `report.errors`, so anything alerting on `errors.length` never learns about it. That
  // decision is not reversed here — the job still succeeds and is not retried, because an
  // adapter that hands back documents without advancing its cursor has skipped nothing and
  // retrying it would replay the identical page. It is repeated at warn level because this
  // is the layer an operator actually watches, and a condition visible only to someone who
  // thinks to query `stopReason` on a `runs` row is visible to nobody.
  if (counts.stopReason === 'no-progress-with-documents') {
    log.warn('scheduled ingest saw an adapter return documents without advancing its cursor', {
      source,
      run_id: report.runId,
      documents: counts.fetched,
      effect: 'not a failure and not retried; the same page will be offered again next run',
    });
  }

  if (report.status === 'FAILED') {
    throw new AppError(
      'INGEST_RUN_FAILED',
      `Scheduled ingest of "${source}" failed: the source was attempted and produced nothing usable (${counts.status})`,
      {
        context: {
          source,
          runId: report.runId,
          sourceStatus: counts.status,
          stopReason: counts.stopReason,
          // Codes and messages only. The whole error records are already on the `runs` row;
          // this exists so the dead letter entry says why without a second lookup.
          errors: report.errors.map((entry) => ({
            kind: entry.kind,
            name: entry.name,
            code: entry.code,
            message: entry.message,
          })),
        },
      },
    );
  }

  if (report.status === 'PARTIAL') {
    // Not a retry. Documents from the partial pages were written, the cursor advanced past
    // what succeeded, and re-running would re-fetch ground already covered to re-attempt a
    // failure the next scheduled tick will re-attempt anyway.
    log.warn('scheduled ingest run completed with errors', {
      source,
      run_id: report.runId,
      sourceStatus: counts.status,
      stopReason: counts.stopReason,
      errorCount: report.errors.length,
      totals: report.totals,
    });
    return result;
  }

  log.info('scheduled ingest run complete', {
    source,
    run_id: report.runId,
    sourceStatus: counts.status,
    stopReason: counts.stopReason,
    totals: report.totals,
  });
  return result;
}
