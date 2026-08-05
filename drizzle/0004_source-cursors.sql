-- I-05 blocker B-08: nothing in the schema held adapter state between runs, so every
-- `fetchIncremental(cursor)` call started from `undefined` and the opaque-cursor design
-- (sources/types.ts `Cursor`) was dead code. One row per source, holding the token verbatim.
--
-- Deliberately NOT covered by 0002/0003's append-only triggers (composer resolution I-05 #1):
-- a high-water mark advances by definition, so this table is mutable by design. `documents`
-- keeps its triggers untouched — this migration adds a table and changes nothing else.
CREATE TABLE "source_cursors" (
	"source" "source" PRIMARY KEY NOT NULL,
	"cursor" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
