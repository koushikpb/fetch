// Build-time tooling config for `drizzle-kit generate`/`migrate` — not application code, so
// this is the one authorized place in this task to read `process.env.DATABASE_URL`
// directly (composer resolution F-02 #8; F-03's forthcoming `process.env` lint ban targets
// runtime modules like db/index.ts, db/seed.ts, and db/migrate.ts, not this file).
import { defineConfig } from 'drizzle-kit';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://nick@localhost:5432/fetch_dev';

export default defineConfig({
  dialect: 'postgresql',
  schema: './db/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: DATABASE_URL,
  },
});
