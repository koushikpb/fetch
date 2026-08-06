// The scheduler process (SPEC I-06) — same shape and rationale as scripts/ingest.ts, which
// runs every source once and exits. This one stays up: it registers the configured cron
// schedules and works the per-source queues until it is signalled to stop.
//
// `bootConfig()` is called here rather than inside jobs/ for the same reason it is called in
// scripts/ingest.ts: this wrapper is the composition root, and it is the only layer allowed
// to read `process.env` (via lib/config.ts).
import { createDb } from '../db/index.js';
import {
  createDrizzleCursorStore,
  createDrizzleDocumentSink,
  createDrizzleIngestRunRecorder,
} from '../ingest/index.js';
import { startIngestWorker, type IngestWorker } from '../jobs/index.js';
import { bootConfig } from '../lib/config.js';
import { AppError } from '../lib/errors.js';
import { log } from '../lib/log.js';
import { createRegistry } from '../sources/registry.js';

const SHUTDOWN_SIGNALS = ['SIGINT', 'SIGTERM'] as const;

async function main(): Promise<void> {
  const config = bootConfig();
  const { db, close } = createDb(config.databaseUrl);
  let worker: IngestWorker | undefined;
  try {
    worker = await startIngestWorker({
      config,
      context: {
        registry: createRegistry(config),
        documents: createDrizzleDocumentSink(db),
        cursors: createDrizzleCursorStore(db),
        runs: createDrizzleIngestRunRecorder(db),
      },
    });

    const started = worker;
    await new Promise<void>((resolve) => {
      let stopping = false;
      const shutdown = (signal: string): void => {
        // A second Ctrl-C should not start a second shutdown on top of the first — pg-boss
        // is already waiting for whatever run is in flight, and stopping twice concurrently
        // would race that wait against itself.
        if (stopping) {
          log.warn('shutdown already in progress; ignoring repeat signal', { signal });
          return;
        }
        stopping = true;
        log.info('ingest worker shutting down', { signal });
        started
          .stop()
          .then(resolve)
          .catch((error: unknown) => {
            // Resolve either way: the process is on its way out, and the `finally` below
            // still has a database pool to close. Losing the reason would be the only real
            // harm, so it is logged before that happens.
            log.error('ingest worker did not stop cleanly', { error });
            process.exitCode = 1;
            resolve();
          });
      };
      for (const signal of SHUTDOWN_SIGNALS) {
        process.once(signal, () => {
          shutdown(signal);
        });
      }
    });
  } finally {
    await close();
  }
  log.info('ingest worker stopped');
}

// Same cause-walking rationale as scripts/ingest.ts: the diagnostic that actually explains a
// connection failure is nested under `.cause`, and pg-pool reports one as an AggregateError
// whose own `.message` is empty.
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
  console.error(`ingest worker failed — ${message}`);
  process.exitCode = 1;
});
