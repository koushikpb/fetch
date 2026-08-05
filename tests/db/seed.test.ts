// Criterion 5: a seed script inserts 20 fixture documents across all three sources.
// Provisions its own scratch database (see tests/db/schema.test.ts for the rationale) so
// this suite's row counts can never be perturbed by other tests or by manual local use of
// fetch_dev/fetch_test. Provisioning itself lives in tests/db/scratch-database.ts (R-03 fix
// round) — extracted after this file and tests/db/schema.test.ts independently grew an
// identical CREATE/migrate/DROP block.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { documents } from '../../db/schema.js';
import { seed } from '../../db/seed.js';
import { setupScratchDatabase, teardownScratchDatabase, type ScratchDatabase } from './scratch-database.js';

let handle: ScratchDatabase;

beforeAll(async () => {
  handle = await setupScratchDatabase('seed_test');
}, 30_000);

afterAll(async () => {
  await teardownScratchDatabase(handle);
}, 30_000);

describe('criterion 5: seed script inserts 20 fixture documents across all three sources', () => {
  it('inserts exactly 20 documents on the first run', async () => {
    const result = await seed(handle.connectionString);
    expect(result.inserted).toBe(20);

    const rows = await handle.target.db.select({ source: documents.source }).from(documents);
    expect(rows).toHaveLength(20);
  });

  it('spans all three sources with a realistic spread, not 18/1/1 (resolution F-02 #7)', async () => {
    const rows = await handle.target.db.select({ source: documents.source }).from(documents);
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
    const second = await seed(handle.connectionString);
    expect(second.inserted).toBe(0);

    const rows = await handle.target.db.select({ source: documents.source }).from(documents);
    expect(rows).toHaveLength(20);
  });
});
