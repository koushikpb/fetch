// Connection/client factory. Takes the connection string as a parameter rather than
// reading `process.env` itself (composer resolution F-02 #8) — F-03 is concurrently adding
// a lint ban on `process.env` access outside its config module, which does not exist on
// this branch yet, so every caller (application code, db/migrate.ts, db/seed.ts, tests)
// must resolve the connection string itself and pass it in here.
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema.js';

export type Db = NodePgDatabase<typeof schema>;

export interface DbHandle {
  db: Db;
  /** Closes the underlying connection pool. Callers own the lifetime of what they open. */
  close: () => Promise<void>;
}

export function createDb(connectionString: string): DbHandle {
  const pool = new Pool({ connectionString });
  const db = drizzle(pool, { schema });
  return { db, close: () => pool.end() };
}
