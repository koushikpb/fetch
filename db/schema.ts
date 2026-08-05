// Canonical Drizzle schema for every table in the pipeline (CLAUDE.md architecture:
// documents -> embeddings -> pain_points -> clusters/cluster_members -> scores -> briefs,
// plus runs for per-run bookkeeping). This file doubles as this module's `types.ts`
// (CLAUDE.md "each module exports its types from a local types.ts") — Drizzle's
// `$inferSelect`/`$inferInsert` derive row types directly from the table definitions below,
// so a separate types.ts would only re-export the same inference with no independent
// meaning, and the task brief does not list one.
//
// Traceability shape (composer resolution F-02 #4): many-to-many derived tables
// (pain_points, clusters, briefs) carry a non-null `source_document_ids` array back to
// `documents`; strict parent-child tables (embeddings, cluster_members, scores) carry a
// foreign key instead. tests/db/schema.test.ts walks both routes and asserts every derived
// table reaches `documents`.
import {
  pgEnum,
  pgTable,
  timestamp,
  text,
  uuid,
  jsonb,
  integer,
  numeric,
  vector,
  unique,
} from 'drizzle-orm/pg-core';

// Composer resolution F-02 #2: 1536 is the column width pending the embedding-provider
// decision (tracked separately, gating X-01). A single exported constant means the future
// migration that changes it has one obvious place to start.
export const EMBEDDING_DIMENSIONS = 1536;

// Only the three v1 sources (CLAUDE.md non-goals: no X/Twitter in v1). Adding a fourth
// source later is an `ALTER TYPE ... ADD VALUE` migration, not a schema rewrite.
export const sourceEnum = pgEnum('source', ['hackernews', 'appstore', 'reddit']);
export type Source = (typeof sourceEnum.enumValues)[number];

// Append-only (CLAUDE.md: "documents is append-only... it never mutates ingested source
// data"). The structural guarantee lives in a database trigger, not here — see
// drizzle/0002_enforce-append-only.sql, proven by tests/db/schema.test.ts attempting an
// UPDATE and a DELETE and asserting both fail.
export const documents = pgTable(
  'documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    source: sourceEnum('source').notNull(),
    sourceId: text('source_id').notNull(),
    url: text('url').notNull(),
    // Nullable: a deleted or anonymized account still has a document worth keeping.
    authorHandle: text('author_handle'),
    // Nullable: App Store reviews and Reddit comments do not always carry a title.
    title: text('title'),
    body: text('body').notNull(),
    // The platform's own creation time, distinct from `ingestedAt` below.
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    ingestedAt: timestamp('ingested_at', { withTimezone: true }).notNull().defaultNow(),
    // Engagement metrics vary per platform (HN points/comments, Reddit score/upvote-ratio,
    // App Store rating) — jsonb avoids a table full of source-specific nullable columns.
    engagement: jsonb('engagement').$type<Record<string, unknown>>().notNull().default({}),
    // The untouched API response, kept for provenance and re-normalization if the adapter's
    // mapping logic ever needs to change retroactively.
    raw: jsonb('raw').$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => [unique('documents_source_source_id_unique').on(t.source, t.sourceId)],
);

export const embeddings = pgTable(
  'embeddings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Parent-child link to primary evidence (composer resolution F-02 #4).
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id),
    // The embedding model/version, since the provider is an unresolved gap (composer
    // resolution F-02 #2) — recording it here is what makes a future provider migration
    // detectable per row instead of assumed uniform.
    model: text('model').notNull(),
    vector: vector('vector', { dimensions: EMBEDDING_DIMENSIONS }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  // X-01 criterion: re-running embeds zero already-embedded docs. A unique constraint on
  // (document, model) is what makes that idempotency enforceable at the database level
  // rather than trusted to the caller's logic.
  (t) => [unique('embeddings_document_id_model_unique').on(t.documentId, t.model)],
);

export const painPoints = pgTable('pain_points', {
  id: uuid('id').primaryKey().defaultRandom(),
  // Many-to-many link to primary evidence (composer resolution F-02 #4) — a pain point can
  // be extracted from more than one document (e.g. a thread and its top comment).
  sourceDocumentIds: uuid('source_document_ids').array().notNull(),
  problemStatement: text('problem_statement').notNull(),
  domain: text('domain'),
  intensitySignal: text('intensity_signal'),
  // Extraction fields (X-03: workarounds mentioned, existing tools mentioned, quoted
  // evidence spans) are arrays of heterogeneous structured data the extraction prompt
  // produces — jsonb rather than a normalized child table, since X-04 is the task that
  // defines their exact shape.
  workarounds: jsonb('workarounds').$type<unknown[]>().notNull().default([]),
  existingTools: jsonb('existing_tools').$type<unknown[]>().notNull().default([]),
  evidenceSpans: jsonb('evidence_spans').$type<unknown[]>().notNull().default([]),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const clusters = pgTable('clusters', {
  id: uuid('id').primaryKey().defaultRandom(),
  // Many-to-many link to primary evidence (composer resolution F-02 #4), denormalized from
  // member pain points' own `source_document_ids` at cluster-write time so traceability
  // doesn't depend on always joining through cluster_members.
  sourceDocumentIds: uuid('source_document_ids').array().notNull(),
  label: text('label'),
  // Nullable: only meaningful once C-01 computes a centroid; the row can exist before that.
  centroid: vector('centroid', { dimensions: EMBEDDING_DIMENSIONS }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const clusterMembers = pgTable(
  'cluster_members',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Parent-child link (composer resolution F-02 #4): traceability reaches documents via
    // clusterId -> clusters.sourceDocumentIds or painPointId -> painPoints.sourceDocumentIds.
    clusterId: uuid('cluster_id')
      .notNull()
      .references(() => clusters.id),
    painPointId: uuid('pain_point_id')
      .notNull()
      .references(() => painPoints.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('cluster_members_cluster_id_pain_point_id_unique').on(t.clusterId, t.painPointId)],
);

export const scores = pgTable('scores', {
  id: uuid('id').primaryKey().defaultRandom(),
  // Parent-child link to primary evidence (composer resolution F-02 #4).
  clusterId: uuid('cluster_id')
    .notNull()
    .references(() => clusters.id),
  // C-03: component scores persisted individually, not just the composite — debugging a
  // bad ranking requires seeing which term caused it. `numeric` (not float) so weighted
  // sums stay exact and reproducible across the calibration harness (C-05).
  frequency: numeric('frequency'),
  intensity: numeric('intensity'),
  recency: numeric('recency'),
  sourceDiversity: numeric('source_diversity'),
  solutionGap: numeric('solution_gap'),
  composite: numeric('composite').notNull(),
  computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
});

export const briefs = pgTable('briefs', {
  id: uuid('id').primaryKey().defaultRandom(),
  // Retained alongside the array below for "which cluster is this the brief for" queries;
  // does not substitute for it — resolution F-02 #4 requires the array on this table.
  clusterId: uuid('cluster_id')
    .notNull()
    .references(() => clusters.id),
  // Many-to-many link to primary evidence (composer resolution F-02 #4).
  sourceDocumentIds: uuid('source_document_ids').array().notNull(),
  // S-01's structured brief (problem, who has it, evidence, existing solutions and gaps,
  // why now, minimal product) — shape is that task's to define; jsonb here avoids this
  // schema anticipating fields a not-yet-written prompt will decide.
  content: jsonb('content').$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// Generic run-tracking row, written by more than one later stage: I-05 (ingest counts per
// source, duration, errors) and F-05 (per-call token accounting and cost). `stage`
// distinguishes which pipeline phase (CLAUDE.md architecture) a row belongs to; `counts`
// and `errors` are jsonb because their shape is necessarily stage-specific.
export const runs = pgTable('runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  stage: text('stage').notNull(),
  status: text('status').notNull().default('running'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  inputTokens: integer('input_tokens'),
  outputTokens: integer('output_tokens'),
  model: text('model'),
  costUsd: numeric('cost_usd', { precision: 10, scale: 4 }),
  counts: jsonb('counts').$type<Record<string, unknown>>().notNull().default({}),
  errors: jsonb('errors').$type<unknown[]>().notNull().default([]),
});

export type DocumentRow = typeof documents.$inferSelect;
export type NewDocumentRow = typeof documents.$inferInsert;
export type EmbeddingRow = typeof embeddings.$inferSelect;
export type PainPointRow = typeof painPoints.$inferSelect;
export type ClusterRow = typeof clusters.$inferSelect;
export type ClusterMemberRow = typeof clusterMembers.$inferSelect;
export type ScoreRow = typeof scores.$inferSelect;
export type BriefRow = typeof briefs.$inferSelect;
export type RunRow = typeof runs.$inferSelect;
