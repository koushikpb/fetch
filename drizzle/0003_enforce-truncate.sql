-- Fix round 1 (review finding, Important): 0002_enforce-append-only.sql only declared
-- BEFORE UPDATE/DELETE row-level triggers. Postgres does not fire a row-level trigger for
-- TRUNCATE at all — it requires its own BEFORE TRUNCATE ... FOR EACH STATEMENT trigger —
-- so `TRUNCATE documents CASCADE` silently emptied the table with zero errors (reproduced
-- against a scratch database before this fix; a bare `TRUNCATE documents` only failed
-- incidentally, because `embeddings` holds a foreign key into `documents`, and that
-- incidental protection disappears the moment CASCADE is added). 0002 has already been
-- applied, so this closes the gap forward rather than editing it (composer resolution
-- F-02 #6: migrations are forward-only).
--
-- Reuses documents_append_only() unchanged: the function only references TG_OP, never OLD
-- or NEW, so it is valid in both the row-level context 0002 uses it in and the
-- statement-level context here — verified empirically (see fix round 1 report) rather than
-- assumed, since a row-level function that touched OLD/NEW would need a different function
-- for a statement-level trigger.
CREATE TRIGGER documents_no_truncate
  BEFORE TRUNCATE ON documents
  FOR EACH STATEMENT
  EXECUTE FUNCTION documents_append_only();
