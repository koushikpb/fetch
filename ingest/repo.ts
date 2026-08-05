// The only part of ingest/ that touches Postgres. Everything the orchestrator does is
// expressed against the narrow interfaces in ./types.ts; these three factories are their one
// real implementation, mirroring lib/llm.ts's `createDrizzleRunsRepo`.
//
// `Db` is imported from db/index.ts across directories, exactly as lib/llm.ts already does
// for the same reason: it is a handle to the database seam, not a shared data shape, so it
// is not what CLAUDE.md's "no cross-directory type imports except from lib/types.ts"
// constrains. Confining that import to this file is what keeps the orchestrator and its
// tests free of it.
import { eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { documents, runs, sourceCursors } from '../db/schema.js';
import { AppError } from '../lib/errors.js';
import type { Document, Source } from '../lib/types.js';
import type { Cursor } from '../sources/types.js';
import type { CursorStore, DocumentSink, IngestRunFinish, IngestRunRecorder } from './types.js';

/**
 * Rows per `INSERT`. Postgres caps a statement at 65535 bind parameters and `documents` binds
 * 9 per row, so ~7280 rows is the hard ceiling; 500 keeps a long way clear of it while still
 * being one round trip for any realistic page. A Hacker News page can carry 1000+ documents
 * at the adapter's default `hitsPerPage`, so this is reachable, not theoretical.
 */
export const DEFAULT_INSERT_BATCH_SIZE = 500;

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

/**
 * Dedup is the `documents_source_source_id_unique` constraint, not a read-then-write: SPEC
 * I-05 criterion 1 ("re-running immediately inserts zero new rows") has to hold under
 * concurrent runs, and a SELECT-then-INSERT is a race where the constraint is not.
 *
 * `documents` is append-only (0002/0003's triggers), so `onConflictDoNothing` is also the
 * only conflict action available — `DO UPDATE` would fire the BEFORE UPDATE trigger and
 * raise. That is the intended design, not a limitation worked around: a document that
 * already exists is never rewritten.
 */
export function createDrizzleDocumentSink(
  db: Db,
  batchSize: number = DEFAULT_INSERT_BATCH_SIZE,
): DocumentSink {
  return {
    async insert(docs) {
      // Drizzle rejects `.values([])` outright, so an empty page short-circuits rather than
      // being handed to the driver.
      if (docs.length === 0) {
        return 0;
      }
      let inserted = 0;
      for (const batch of chunk(docs, batchSize)) {
        const rows = await db
          .insert(documents)
          .values(batch as Document[])
          .onConflictDoNothing({ target: [documents.source, documents.sourceId] })
          // Counting the returned rows, rather than trusting `rowCount`, is what makes the
          // orchestrator's `duplicates` figure real: `RETURNING` emits a row only for what
          // was actually inserted, so offered-minus-returned is exactly the duplicates.
          .returning({ id: documents.id });
        inserted += rows.length;
      }
      return inserted;
    },
  };
}

export function createDrizzleCursorStore(db: Db): CursorStore {
  return {
    async get(source: Source): Promise<Cursor | undefined> {
      const [row] = await db
        .select({ cursor: sourceCursors.cursor })
        .from(sourceCursors)
        .where(eq(sourceCursors.source, source));
      return row?.cursor;
    },
    async set(source: Source, cursor: Cursor): Promise<void> {
      const updatedAt = new Date();
      // Upsert rather than insert-or-update in two statements: two runs of the same source
      // racing here would otherwise have one of them fail on the primary key. `source_cursors`
      // is deliberately mutable (db/schema.ts) — this is the one table in the pipeline whose
      // job is to be overwritten.
      await db
        .insert(sourceCursors)
        .values({ source, cursor, updatedAt })
        .onConflictDoUpdate({ target: sourceCursors.source, set: { cursor, updatedAt } });
    },
  };
}

export function createDrizzleIngestRunRecorder(db: Db): IngestRunRecorder {
  return {
    async start(stage: string): Promise<string> {
      const [row] = await db.insert(runs).values({ stage }).returning({ id: runs.id });
      if (row === undefined) {
        // Postgres guarantees a single-row RETURNING for a successful single-row INSERT, so
        // reaching here means the row this run's entire record depends on does not exist —
        // loud now beats a run that completes and reports nothing.
        throw new AppError(
          'INGEST_RUN_INSERT_RETURNED_NO_ROW',
          `Insert into runs returned no row for stage "${stage}"`,
          {
            context: { stage },
          },
        );
      }
      return row.id;
    },
    async finish(runId: string, result: IngestRunFinish): Promise<void> {
      const updated = await db
        .update(runs)
        .set({
          status: result.status,
          finishedAt: result.finishedAt,
          counts: result.counts,
          // Spread into a plain array: the column is jsonb and the orchestrator hands over a
          // readonly array, which Drizzle serializes the same either way.
          errors: [...result.errors],
        })
        .where(eq(runs.id, runId));
      if ((updated.rowCount ?? 0) === 0) {
        // The same failure lib/llm.ts's `recordUsage` guards against, for the same reason: an
        // UPDATE matching no row returns normally, so without this a run's entire record —
        // counts, duration, errors — would vanish with no signal at all.
        throw new AppError(
          'INGEST_RUN_ROW_MISSING',
          `No runs row exists for runId "${runId}" — cannot record the run's result`,
          {
            context: { runId },
          },
        );
      }
    },
  };
}
