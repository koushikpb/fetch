// Build-time tooling config for `drizzle-kit generate`/`migrate` — not application code, but
// still bound by F-03's `process.env` ban (R-01 reconciliation): rather than carving an
// exception, this goes through `bootConfig()` — the same boot-time entry point every other
// process uses — so drizzle-kit gets the identical validated, fail-loudly-on-missing
// DATABASE_URL as the rest of the app, instead of a silent fallback to a guessed dev URL.
// `bootConfig()` (not `loadConfigFromEnv()`) is deliberate: it's the variant that prints a
// clean one-line message and exits non-zero on a `ConfigError`, which is the right failure
// mode for a CLI entry point — `loadConfigFromEnv()` would surface the same problem as a raw
// thrown exception with a full stack trace.
import { defineConfig } from 'drizzle-kit';
import { bootConfig } from './lib/config.js';

const { databaseUrl } = bootConfig();

export default defineConfig({
  dialect: 'postgresql',
  schema: './db/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: databaseUrl,
  },
});
