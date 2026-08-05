// CLI entry point for `seed` (db/seed.ts) — same rationale as scripts/db-migrate.ts. `seed`
// is idempotent (relies on the `(source, source_id)` unique constraint via
// `onConflictDoNothing`), so re-running this against an already-seeded database is expected
// to report 0 inserted rather than fail.
import { AppError } from '../lib/errors.js';
import { bootConfig } from '../lib/config.js';
import { seed } from '../db/seed.js';

async function main(): Promise<void> {
  const { databaseUrl } = bootConfig();
  const { inserted } = await seed(databaseUrl);
  console.log(`Seed complete — inserted ${inserted} document(s).`);
}

// `seed` propagates raw Drizzle/pg errors, not AppError — so on the most likely real
// failure (bad host/port, auth, database down), the diagnostic that actually explains it is
// not on the wrapper's own `.message` ("Failed query: ...") but nested under `.cause`, and
// pg-pool's connection failures arrive as an AggregateError whose own `.message` is empty —
// the real text ("connect ECONNREFUSED ...") lives in `.errors`. Verified directly by
// pointing DATABASE_URL at a closed port: without this walk, the printed message names only
// the SQL that failed and never mentions ECONNREFUSED.
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
  console.error(`db:seed failed — ${message}`);
  process.exitCode = 1;
});
