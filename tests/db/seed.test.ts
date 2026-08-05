// Criterion 5: a seed script inserts 20 fixture documents across all three sources.
// Provisions its own scratch database (see tests/db/schema.test.ts for the rationale) so
// this suite's row counts can never be perturbed by other tests or by manual local use of
// fetch_dev/fetch_test.
import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type DbHandle } from '../../db/index.js';
import { runMigrations } from '../../db/migrate.js';
import { documents } from '../../db/schema.js';
import { seed } from '../../db/seed.js';

const ADMIN_CONNECTION = 'postgres://nick@localhost:5432/fetch_dev';
const SCRATCH_DB = `fetch_scratch_seed_test_${randomBytes(4).toString('hex')}`;
const SCRATCH_CONNECTION = `postgres://nick@localhost:5432/${SCRATCH_DB}`;

let admin: Client;
let target: DbHandle;

beforeAll(async () => {
  admin = new Client({ connectionString: ADMIN_CONNECTION });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${SCRATCH_DB}"`);
  await runMigrations(SCRATCH_CONNECTION);
  target = createDb(SCRATCH_CONNECTION);
}, 30_000);

afterAll(async () => {
  await target.close();
  await admin.query(`DROP DATABASE IF EXISTS "${SCRATCH_DB}" WITH (force)`);
  await admin.end();
}, 30_000);

describe('criterion 5: seed script inserts 20 fixture documents across all three sources', () => {
  it('inserts exactly 20 documents on the first run', async () => {
    const result = await seed(SCRATCH_CONNECTION);
    expect(result.inserted).toBe(20);

    const rows = await target.db.select({ source: documents.source }).from(documents);
    expect(rows).toHaveLength(20);
  });

  it('spans all three sources with a realistic spread, not 18/1/1 (resolution F-02 #7)', async () => {
    const rows = await target.db.select({ source: documents.source }).from(documents);
    const counts = rows.reduce<Record<string, number>>((acc, row) => {
      acc[row.source] = (acc[row.source] ?? 0) + 1;
      return acc;
    }, {});
    expect(counts).toEqual({ hackernews: 7, appstore: 6, reddit: 7 });
    // No single source should dominate the fixture set the way 18/1/1 would.
    for (const count of Object.values(counts)) {
      expect(count).toBeGreaterThanOrEqual(5);
    }
  });

  it('re-running the seed inserts zero new rows (relies on the (source, source_id) unique constraint)', async () => {
    const second = await seed(SCRATCH_CONNECTION);
    expect(second.inserted).toBe(0);

    const rows = await target.db.select({ source: documents.source }).from(documents);
    expect(rows).toHaveLength(20);
  });
});
