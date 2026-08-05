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

main().catch((error: unknown) => {
  const message = error instanceof AppError ? `${error.code}: ${error.message}` : String(error);
  console.error(`db:seed failed — ${message}`);
  process.exitCode = 1;
});
