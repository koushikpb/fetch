// Shared scratch-database provisioning for db-integration suites (R-03 fix round, Finding
// 3's related Minor). tests/db/schema.test.ts and tests/db/seed.test.ts each independently
// grew a byte-for-byte identical block — admin client, CREATE DATABASE, runMigrations,
// DROP DATABASE ... WITH (force) — with nothing forcing the two to stay in sync. Extracting
// it here means a future db-integration suite (this task adds a third, tests/db/runs.test.ts)
// reuses the same provisioning rather than copying it a third time.
//
// R-03 Finding 3: this admin connection should be overridable via an environment variable
// (e.g. TEST_ADMIN_DATABASE_URL) so a contributor or CI runner without a role named `nick`
// can still run `pnpm verify`. That part of the fix is BLOCKED, not implemented: reading
// `process.env` here would violate eslint.config.js's PROCESS_ENV_BAN, which the TESTS_GLOB
// override picks back up for tests/** rather than lifting (see tests/eslint-rules.test.ts's
// "still reports process.env access inside tests/** — no exemption there either"), and
// lib/config.ts — the one module the ban exempts — is out of this task's file scope. Widening
// either is a composer decision, not this task's to make; the value stays hardcoded, per the
// task brief's explicit instruction for exactly this situation.
import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import { createDb, type DbHandle } from '../../db/index.js';
import { runMigrations } from '../../db/migrate.js';

const ADMIN_CONNECTION = 'postgres://nick@localhost:5432/fetch_dev';

export interface ScratchDatabase {
  /** Stays connected to the admin database (fetch_dev) for the suite's lifetime — CREATE
   *  DATABASE and DROP DATABASE cannot target the database a session is currently connected
   *  to, so this connection is never pointed at the scratch database itself. */
  admin: Client;
  /** The migrated scratch database, ready to query via Drizzle. */
  target: DbHandle;
  /** Connection string for the scratch database — for callers that need their own raw
   *  `pg.Client` into it (e.g. information_schema introspection, which only ever exposes
   *  the *currently connected* database's objects regardless of any table_catalog filter). */
  connectionString: string;
  /** The bare database name, for callers that need it directly (e.g. a second raw client's
   *  own logging) without re-parsing `connectionString`. */
  databaseName: string;
}

/**
 * Creates a uniquely-named scratch database, applies every migration to it, and returns a
 * ready-to-use Drizzle handle plus the admin connection used to create it. `namePrefix`
 * should identify the calling suite (e.g. `'schema_test'`) so a failed teardown leaves a
 * recognizable trail rather than an opaque random name.
 *
 * Every scratch database provisioned this way must be dropped via `teardownScratchDatabase`
 * in `afterAll` — CLAUDE.md: do not mutate fetch_dev or fetch_test, so tests never reuse a
 * shared database, only ever a fresh one they alone own for the suite's lifetime.
 */
export async function setupScratchDatabase(namePrefix: string): Promise<ScratchDatabase> {
  const databaseName = `fetch_scratch_${namePrefix}_${randomBytes(4).toString('hex')}`;
  const connectionString = `postgres://nick@localhost:5432/${databaseName}`;
  const admin = new Client({ connectionString: ADMIN_CONNECTION });
  await admin.connect();
  // CREATE DATABASE cannot run inside a transaction block; node-postgres issues each
  // `query()` call as its own implicit statement, which is what makes this safe outside a
  // transaction without an explicit `autocommit` setting.
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  await runMigrations(connectionString);
  const target = createDb(connectionString);
  return { admin, target, connectionString, databaseName };
}

/** Drops the scratch database `setupScratchDatabase` created and closes both connections. */
export async function teardownScratchDatabase(scratch: ScratchDatabase): Promise<void> {
  await scratch.target.close();
  // `WITH (force)` (PG13+) is a safety net in case a test above failed before closing its
  // own connection — DROP DATABASE otherwise refuses while any session is attached.
  await scratch.admin.query(`DROP DATABASE IF EXISTS "${scratch.databaseName}" WITH (force)`);
  await scratch.admin.end();
}
