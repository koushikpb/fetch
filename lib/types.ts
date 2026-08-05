// Cross-directory contracts every other module may import (CLAUDE.md: "no cross-directory
// type imports except from lib/types.ts"). `Document` and `Source` live here specifically
// because sources/, ingest/, and db/ all need them — sources/ produces `Document` values,
// ingest/ writes them into the `documents` table, and db/schema.ts defines that table.
//
// This file itself imports *from* db/schema.ts below (type-only, so `isolatedModules`
// guarantees it is fully erased — no runtime dependency on drizzle-orm or the table
// definitions). That is not the cross-directory import the CLAUDE.md convention forbids:
// the convention constrains what *other* modules may reach into (only this file, never
// db/schema.ts directly), not what this file — the designated hub — may reference to keep
// itself honest. The alternative, db/schema.ts importing back from here to run the same
// check, would create the two-way dependency the convention exists to avoid. sources/ and
// ingest/ still may not import db/schema.ts directly; they get `Document` and `Source` from
// here.
import type { NewDocumentRow, Source as SchemaSource } from '../db/schema.js';

/**
 * The three v1 sources (CLAUDE.md non-goals: no X/Twitter in v1). Declared independently of
 * db/schema.ts's `sourceEnum` — sources/ and ingest/ may only import cross-directory types
 * from this file, not from db/schema.ts — and checked against it below instead, so a future
 * migration that changes the enum breaks `pnpm typecheck` here rather than surprising
 * someone three phases later when an adapter emits a `source` value the database rejects.
 */
export const SOURCES = ['hackernews', 'appstore', 'reddit'] as const;
export type Source = (typeof SOURCES)[number];

/**
 * Adapter-produced `engagement`/`raw` payloads are inherently platform-specific (Hacker
 * News points/comments, Reddit score/upvote_ratio, App Store rating/votes) — an index
 * signature mirrors db/schema.ts's jsonb columns rather than forcing a discriminated union
 * of three unrelated shapes onto this shared file. A given adapter's own types.ts is free
 * to narrow this further for its own internal use before producing a `Document`.
 */
export type JsonRecord = Record<string, unknown>;

/**
 * What a `SourceAdapter` produces, one per platform item — the pre-insert shape, excluding
 * the two columns the database owns (`id`, `ingestedAt`). CLAUDE.md global rule 1 ("every
 * scored pain point traces to source URLs") is why `url` and `sourceId` are required, not
 * optional: a Document that cannot be traced back to its origin is not evidence.
 */
export interface Document {
  readonly source: Source;
  readonly sourceId: string;
  readonly url: string;
  /** Nullable: a deleted or anonymized account still has a document worth keeping. */
  readonly authorHandle: string | null;
  /** Nullable: App Store reviews and Reddit comments do not always carry a title. */
  readonly title: string | null;
  readonly body: string;
  /**
   * The platform's own creation time — timestamptz, UTC (CLAUDE.md conventions) — distinct
   * from the database-assigned `ingestedAt`.
   */
  readonly createdAt: Date;
  readonly engagement: JsonRecord;
  readonly raw: JsonRecord;
}

// --- Compile-time-only assertions (composer resolution 2) ------------------------------
//
// `Expect<true>` only typechecks when its argument's type is exactly the literal `true`;
// neither of these executes anything at runtime. A future migration that changes a
// `documents` column, or adds/removes/renames a `source` enum value, in a way `Document` or
// `Source` no longer matches fails `pnpm typecheck` right here instead of surfacing as a
// runtime insert failure three phases later. Both are `export`ed solely so nothing treats
// them as dead code — nothing is meant to import them, the typecheck itself is the point.
type Expect<T extends true> = T;

// `Document` must be assignable to the table's own insert type: every field
// `NewDocumentRow` requires, `Document` supplies compatibly, and `Document` correctly omits
// the two columns the database (not the adapter) owns — both optional on `NewDocumentRow`
// because both have a default (`id` via `defaultRandom()`, `ingestedAt` via `defaultNow()`).
export type _DocumentAssignableToInsert = Expect<Document extends NewDocumentRow ? true : false>;

// A one-directional `extends` would still pass if `Source` were missing a value
// `SchemaSource` has (`Document.source` would just end up narrower than necessary, which is
// still assignable to `NewDocumentRow.source`) — checking both directions is what actually
// proves the two lists match instead of one merely being a subset of the other.
export type _SourceMatchesSchemaEnum = Expect<
  Source extends SchemaSource ? (SchemaSource extends Source ? true : false) : false
>;
