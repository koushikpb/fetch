// Inserts the 20 fixture documents (composer resolution F-02 #7: spread across all three
// sources, fixed ids/timestamps, no randomness) from tests/fixtures/documents/ into
// `documents`. Idempotent — re-running relies on the (source, source_id) unique constraint
// via `onConflictDoNothing`, so it never duplicates rows.
//
// Takes the connection string as a parameter, not from `process.env` (composer resolution
// F-02 #8 — see db/index.ts). No CLI entry point, for the same reason db/migrate.ts has
// none: bare `node db/seed.ts` cannot resolve this file's own local `.js`-specifier imports
// without a build step or TS runner this repo does not yet have. `seed` is exercised
// directly by tests/db/seed.test.ts.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createDb } from './index.js';
import { documents, type Source } from './schema.js';

interface FixtureDocument {
  source: Source;
  source_id: string;
  url: string;
  author_handle: string | null;
  title: string | null;
  body: string;
  created_at: string;
  engagement: Record<string, unknown>;
  raw: Record<string, unknown>;
}

const FIXTURES_DIR = path.join(
  fileURLToPath(new URL('.', import.meta.url)),
  '..',
  'tests',
  'fixtures',
  'documents',
);

// One file per source (composer resolution F-02 #7: "realistic spread, not 18/1/1") rather
// than 20 individual files — keeps the fixture set reviewable as three short lists instead
// of twenty single-document files.
const FIXTURE_FILES = ['hackernews.json', 'appstore.json', 'reddit.json'];

function loadFixtures(): FixtureDocument[] {
  return FIXTURE_FILES.flatMap((file) => {
    const contents = readFileSync(path.join(FIXTURES_DIR, file), 'utf-8');
    return JSON.parse(contents) as FixtureDocument[];
  });
}

export async function seed(connectionString: string): Promise<{ inserted: number }> {
  const { db, close } = createDb(connectionString);
  try {
    const fixtures = loadFixtures();
    const inserted = await db
      .insert(documents)
      .values(
        fixtures.map((f) => ({
          source: f.source,
          sourceId: f.source_id,
          url: f.url,
          authorHandle: f.author_handle,
          title: f.title,
          body: f.body,
          createdAt: new Date(f.created_at),
          engagement: f.engagement,
          raw: f.raw,
        })),
      )
      // Fixed ids mean a second run submits the same (source, source_id) pairs — this is
      // what makes re-running the seed a no-op instead of a duplicate-key error.
      .onConflictDoNothing({ target: [documents.source, documents.sourceId] })
      .returning({ id: documents.id });
    return { inserted: inserted.length };
  } finally {
    await close();
  }
}
