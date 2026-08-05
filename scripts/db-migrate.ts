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

main().catch((error: unknown) => {
  const message = error instanceof AppError ? `${error.code}: ${error.message}` : String(error);
  console.error(`db:migrate failed — ${message}`);
  process.exitCode = 1;
});
