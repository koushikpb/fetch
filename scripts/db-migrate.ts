// CLI entry point for `runMigrations` (db/migrate.ts). F-02 left this unwired because bare
// `node db/migrate.ts` cannot resolve the repo's `.js`-specifier-to-`.ts`-file convention
// without a TS runner — R-05 adds `tsx` for exactly that. `runMigrations` takes a connection
// string rather than reading it itself, so this wrapper is the thing that calls `bootConfig()`
// (the one place allowed to read `process.env`) and hands the validated URL down.
import { AppError } from '../lib/errors.js';
import { bootConfig } from '../lib/config.js';
import { runMigrations } from '../db/migrate.js';

async function main(): Promise<void> {
  const { databaseUrl } = bootConfig();
  await runMigrations(databaseUrl);
  console.log('Migrations applied.');
}

// `runMigrations` propagates raw Drizzle/pg errors, not AppError — so on the most likely
// real failure (bad host/port, auth, database down), the diagnostic that actually explains
// it is not on the wrapper's own `.message` ("Failed query: CREATE SCHEMA...") but nested
// under `.cause`, and pg-pool's connection failures arrive as an AggregateError whose own
// `.message` is empty — the real text ("connect ECONNREFUSED ...") lives in `.errors`.
// Verified directly by pointing DATABASE_URL at a closed port: without this walk, the
// printed message names only the SQL that failed and never mentions ECONNREFUSED.
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
  const message = error instanceof AppError ? `${error.code}: ${error.message}` : describeError(error);
  console.error(`db:migrate failed — ${message}`);
  process.exitCode = 1;
});
