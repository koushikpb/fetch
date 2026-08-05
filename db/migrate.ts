// Migration runner: applies every file in drizzle/ in order (0000_enable-pgvector,
// 0001_init-schema, 0002_enforce-append-only). Forward-only (CLAUDE.md conventions) — there
// is no corresponding "down" migration, matching composer resolution F-02 #6.
//
// Takes the connection string as a parameter, not from `process.env` (composer resolution
// F-02 #8 — see db/index.ts for the full rationale). No CLI entry point: this repo has no
// TypeScript build step or runner yet (tsx/ts-node are not in the authorized dependency
// list — composer resolution F-02 #1), and Node's native type-stripping does not remap a
// `.js` import specifier to a sibling `.ts` file, so a bare `node db/migrate.ts` cannot
// resolve its own local imports. `runMigrations` is exercised directly by
// tests/db/schema.test.ts, which vitest's transform pipeline runs correctly; a real CLI
// entry point is a later task's concern once build tooling exists.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';

const MIGRATIONS_FOLDER = path.join(fileURLToPath(new URL('.', import.meta.url)), '..', 'drizzle');

export async function runMigrations(connectionString: string): Promise<void> {
  const pool = new Pool({ connectionString });
  try {
    const db = drizzle(pool);
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await pool.end();
  }
}
