// CLI entry point for `runIngest` (ingest/) — same rationale and shape as
// scripts/db-migrate.ts and scripts/db-seed.ts. `runIngest` takes its registry and its three
// persistence seams as parameters rather than building them itself, so this wrapper is the
// thing that calls `bootConfig()` (the one place allowed to read `process.env`) and wires the
// validated configuration down.
//
// Scheduling is not here: pg-boss job definitions and schedules are I-06's, which invokes
// `runIngest` the same way this does.
import { createDb } from '../db/index.js';
import { bootConfig } from '../lib/config.js';
import { AppError } from '../lib/errors.js';
import { log } from '../lib/log.js';
import {
  createDrizzleCursorStore,
  createDrizzleDocumentSink,
  createDrizzleIngestRunRecorder,
  runIngest,
} from '../ingest/index.js';
import { createRegistry } from '../sources/registry.js';

async function main(): Promise<void> {
  const config = bootConfig();
  const { db, close } = createDb(config.databaseUrl);
  try {
    const report = await runIngest({
      registry: createRegistry(config),
      documents: createDrizzleDocumentSink(db),
      cursors: createDrizzleCursorStore(db),
      runs: createDrizzleIngestRunRecorder(db),
    });
    log.info('ingest finished', {
      run_id: report.runId,
      status: report.status,
      durationMs: report.durationMs,
      totals: report.totals,
      bySource: report.counts,
      errors: report.errors,
    });
    // PARTIAL exits 0: some sources succeeded, the run recorded exactly what happened, and a
    // scheduler treating a normal degraded run as a job failure would retry work that was
    // never lost. FAILED — nothing usable came back — exits non-zero so it is visible.
    if (report.status === 'FAILED') {
      process.exitCode = 1;
    }
  } finally {
    await close();
  }
}

// `runIngest` propagates raw Drizzle/pg errors from the persistence seams, not AppError — so
// on the most likely real failure (bad host/port, auth, database down), the diagnostic that
// actually explains it is not on the wrapper's own `.message` but nested under `.cause`, and
// pg-pool's connection failures arrive as an AggregateError whose own `.message` is empty —
// the real text ("connect ECONNREFUSED ...") lives in `.errors`. Same walk as
// scripts/db-migrate.ts and scripts/db-seed.ts, for the same reason.
function describeError(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    if (current instanceof AggregateError && current.errors.length > 0) {
      const inner = (current.errors as unknown[])
        .map((e) => (e instanceof Error ? e.message : String(e)))
        .join('; ');
      parts.push(inner);
    } else if (current.message !== '') {
      parts.push(current.message);
    }
    current = current.cause;
  }
  return parts.length > 0 ? parts.join(' — caused by: ') : String(error);
}

main().catch((error: unknown) => {
  const message =
    error instanceof AppError ? `${error.code}: ${error.message}` : describeError(error);
  console.error(`ingest failed — ${message}`);
  process.exitCode = 1;
});
