// Structural proofs for F-02 criteria 1-4. Every assertion here queries live Postgres —
// none of these are config-shape checks — because the criteria are structural claims
// ("append-only", "reaches primary evidence", "all timestamptz") that a comment in
// schema.ts cannot actually guarantee (composer resolutions F-02 #3-#5).
//
// This suite provisions its own scratch database (created in beforeAll, dropped in
// afterAll) rather than using fetch_dev or fetch_test, for two reasons: criterion 1
// requires proving the migration applies to a genuinely *empty* database, and the
// append-only trigger test below inserts a row it can never delete (that is the point of
// the trigger) — reusing a shared, persistent database would leak an undeletable row into
// it on every test run.
//
// The known local connection strings (composer resolution F-02 #8: this file must not read
// `process.env`) come from the task brief, not a secret — this is a fixed local dev
// Postgres instance, not a deployed credential. Provisioning itself lives in
// tests/db/scratch-database.ts (R-03 fix round) — extracted after this file and
// tests/db/seed.test.ts independently grew an identical CREATE/migrate/DROP block.
import { Client } from 'pg';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { documents } from '../../db/schema.js';
import { setupScratchDatabase, teardownScratchDatabase, type ScratchDatabase } from './scratch-database.js';

// The tables this task's schema defines, alongside `documents` itself — used by both the
// "migration applies cleanly" and "all timestamptz" checks below so the expected table list
// only needs to be written once.
const ALL_TABLES = [
  'documents',
  'embeddings',
  'pain_points',
  'clusters',
  'cluster_members',
  'scores',
  'briefs',
  'runs',
];

// Composer resolution F-02 #4: derived tables reach `documents` either via a non-null
// `source_document_ids` array (many-to-many) or a foreign-key chain (parent-child). `runs`
// is deliberately excluded — it is per-run bookkeeping, not a derived table with evidence to
// trace, and doubles as a negative control below (see "does not mark an unrelated table").
const DERIVED_TABLES = [
  'embeddings',
  'pain_points',
  'clusters',
  'cluster_members',
  'scores',
  'briefs',
];

// `handle.admin` stays connected to fetch_dev for the whole suite — CREATE/DROP DATABASE
// cannot target the database a session is currently connected to. `scratch` is a second,
// independent connection into the scratch database itself, used for every
// information_schema / pg_catalog introspection query below: `information_schema.tables`
// (and friends) only ever exposes the *currently connected* database's objects regardless
// of any table_catalog filter, so querying them from `handle.admin` would silently return
// nothing.
let handle: ScratchDatabase;
let scratch: Client;

beforeAll(async () => {
  handle = await setupScratchDatabase('schema_test');
  scratch = new Client({ connectionString: handle.connectionString });
  await scratch.connect();
}, 30_000);

afterAll(async () => {
  await scratch.end();
  await teardownScratchDatabase(handle);
}, 30_000);

describe('criterion 1: migration applies cleanly to an empty Postgres 18 database', () => {
  it('creates every table the schema defines', async () => {
    const { rows } = await scratch.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`,
    );
    const tableNames = rows.map((r) => r.table_name).sort();
    expect(tableNames).toEqual([...ALL_TABLES].sort());
  });

  it('enables pgvector before any table needs it', async () => {
    const { rows } = await scratch.query<{ extname: string }>(
      `SELECT extname FROM pg_catalog.pg_extension WHERE extname = 'vector'`,
    );
    expect(rows).toHaveLength(1);
  });

  it('creates the `source` enum with exactly the three v1 sources', async () => {
    const { rows } = await scratch.query<{ enumlabel: string }>(
      `SELECT enumlabel FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid WHERE t.typname = 'source' ORDER BY enumlabel`,
    );
    expect(rows.map((r) => r.enumlabel)).toEqual(['appstore', 'hackernews', 'reddit']);
  });
});

// drizzle-orm's node-postgres driver wraps every query failure in its own
// `DrizzleQueryError` ("Failed query: ...") and preserves the real Postgres error — the one
// carrying the trigger's RAISE EXCEPTION message — on `.cause` (see
// node_modules/drizzle-orm/errors.js). Rethrowing the cause (not the caught identifier
// itself, so this is not the bare rethrow `no-useless-catch` bans) is what lets the
// assertions below match on the trigger's actual message instead of the wrapper's.
async function rejectingWithCause(fn: () => Promise<unknown>): Promise<never> {
  try {
    await fn();
  } catch (err) {
    const cause = err instanceof Error ? err.cause : undefined;
    throw cause instanceof Error ? cause : err;
  }
  throw new Error('expected the query to reject, but it succeeded');
}

describe('criterion 2: documents has a unique (source, source_id) constraint and is append-only', () => {
  it('rejects a duplicate (source, source_id) insert', async () => {
    await handle.target.db.insert(documents).values({
      source: 'hackernews',
      sourceId: 'dup-test-1',
      url: 'https://example.com/1',
      body: 'first insert',
      createdAt: new Date('2025-01-01T00:00:00.000Z'),
    });
    await expect(
      handle.target.db.insert(documents).values({
        source: 'hackernews',
        sourceId: 'dup-test-1',
        url: 'https://example.com/1-again',
        body: 'second insert, same (source, source_id)',
        createdAt: new Date('2025-01-01T00:00:00.000Z'),
      }),
    ).rejects.toThrow();
  });

  it('rejects an UPDATE against documents (append-only trigger)', async () => {
    const [row] = await handle.target.db
      .insert(documents)
      .values({
        source: 'reddit',
        sourceId: 'append-only-update-test',
        url: 'https://example.com/2',
        body: 'row exists solely to prove UPDATE is rejected',
        createdAt: new Date('2025-01-01T00:00:00.000Z'),
      })
      .returning({ id: documents.id });
    expect(row).toBeDefined();
    await expect(
      rejectingWithCause(() =>
        handle.target.db
          .update(documents)
          .set({ title: 'mutated' })
          .where(eq(documents.id, row?.id ?? '')),
      ),
    ).rejects.toThrow(/append-only/i);
  });

  it('rejects a DELETE against documents (append-only trigger)', async () => {
    const [row] = await handle.target.db
      .insert(documents)
      .values({
        source: 'appstore',
        sourceId: 'append-only-delete-test',
        url: 'https://example.com/3',
        body: 'row exists solely to prove DELETE is rejected',
        createdAt: new Date('2025-01-01T00:00:00.000Z'),
      })
      .returning({ id: documents.id });
    expect(row).toBeDefined();
    await expect(
      rejectingWithCause(() => handle.target.db.delete(documents).where(eq(documents.id, row?.id ?? ''))),
    ).rejects.toThrow(/append-only/i);
  });

  // Fix round 1 (review finding, Important): row-level BEFORE UPDATE/DELETE triggers never
  // fire for TRUNCATE — Postgres requires a separate BEFORE TRUNCATE ... FOR EACH STATEMENT
  // trigger, added in drizzle/0003_enforce-truncate.sql. These use the raw `scratch`
  // connection (not drizzle's query builder, which has no TRUNCATE method) so the assertion
  // is on Postgres's actual response, not on a row count (per the finding's instruction).
  it('rejects TRUNCATE documents', async () => {
    await handle.target.db.insert(documents).values({
      source: 'hackernews',
      sourceId: 'truncate-bare-test',
      url: 'https://example.com/4',
      body: 'row exists to give TRUNCATE something to destroy',
      createdAt: new Date('2025-01-01T00:00:00.000Z'),
    });
    // A bare TRUNCATE on a table another table has a foreign key into already fails in
    // stock Postgres (embeddings -> documents) — that incidental protection is exactly what
    // CASCADE below removes, so this asserts only that it rejects, not what rejects it.
    await expect(scratch.query('TRUNCATE documents')).rejects.toThrow();
  });

  it('rejects TRUNCATE documents CASCADE (the gap fix round 1 closed)', async () => {
    await handle.target.db.insert(documents).values({
      source: 'reddit',
      sourceId: 'truncate-cascade-test',
      url: 'https://example.com/5',
      body: 'row exists to give TRUNCATE CASCADE something to destroy',
      createdAt: new Date('2025-01-01T00:00:00.000Z'),
    });
    // CASCADE removes the incidental FK-based protection the bare-TRUNCATE test above relies
    // on — before 0003_enforce-truncate.sql this silently emptied the table with zero
    // errors. Matching on the trigger's own message (not just "it rejects") is what proves
    // this specific gap is closed, not just that some unrelated error happens to fire.
    await expect(scratch.query('TRUNCATE documents CASCADE')).rejects.toThrow(/append-only/i);
  });
});

describe('criterion 3: every derived table reaches documents (resolution F-02 #4)', () => {
  // Walks information_schema rather than trusting the schema file to be read correctly —
  // this is the "assert it structurally" resolution requires. A table "reaches documents"
  // if it IS documents, carries a non-null `source_document_ids` array itself, or has a
  // foreign key (direct or transitive) to a table that does.
  async function tablesWithNonNullSourceDocumentIds(): Promise<Set<string>> {
    const { rows } = await scratch.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.columns
       WHERE table_schema = 'public' AND column_name = 'source_document_ids' AND is_nullable = 'NO'`,
    );
    return new Set(rows.map((r) => r.table_name));
  }

  async function foreignKeyGraph(): Promise<Map<string, string[]>> {
    const { rows } = await scratch.query<{ source_table: string; target_table: string }>(
      `SELECT tc.table_name AS source_table, ccu.table_name AS target_table
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
       JOIN information_schema.constraint_column_usage ccu
         ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
       WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'`,
    );
    const graph = new Map<string, string[]>();
    for (const { source_table, target_table } of rows) {
      const existing = graph.get(source_table) ?? [];
      existing.push(target_table);
      graph.set(source_table, existing);
    }
    return graph;
  }

  function reachesDocuments(
    table: string,
    arrayTables: Set<string>,
    fkGraph: Map<string, string[]>,
    visited: Set<string> = new Set(),
  ): boolean {
    if (table === 'documents') return true;
    if (arrayTables.has(table)) return true;
    if (visited.has(table)) return false;
    visited.add(table);
    const neighbors = fkGraph.get(table) ?? [];
    return neighbors.some((next) => reachesDocuments(next, arrayTables, fkGraph, visited));
  }

  it.each(DERIVED_TABLES)(
    '%s reaches documents via source_document_ids or a foreign-key chain',
    async (table) => {
      const [arrayTables, fkGraph] = await Promise.all([
        tablesWithNonNullSourceDocumentIds(),
        foreignKeyGraph(),
      ]);
      expect(reachesDocuments(table, arrayTables, fkGraph)).toBe(true);
    },
  );

  // Negative control: proves the walk actually discriminates rather than trivially
  // returning true for every table name. `runs` has neither a `source_document_ids` array
  // nor any foreign key, by design (it is run bookkeeping, not evidence-derived).
  it('does not mark an unrelated table (runs) as reaching documents', async () => {
    const [arrayTables, fkGraph] = await Promise.all([
      tablesWithNonNullSourceDocumentIds(),
      foreignKeyGraph(),
    ]);
    expect(reachesDocuments('runs', arrayTables, fkGraph)).toBe(false);
  });
});

describe('criterion 4: all timestamps are timestamptz (resolution F-02 #5)', () => {
  it('has no column anywhere in the schema typed `timestamp without time zone`', async () => {
    const { rows } = await scratch.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND data_type = 'timestamp without time zone'`,
    );
    expect(rows).toEqual([]);
  });

  it('every timestamp column across the schema is `timestamp with time zone`', async () => {
    const { rows } = await scratch.query<{ data_type: string }>(
      `SELECT data_type FROM information_schema.columns
       WHERE table_schema = 'public' AND column_name LIKE '%_at' AND table_name = ANY($1::text[])`,
      [ALL_TABLES],
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.data_type).toBe('timestamp with time zone');
    }
  });
});
