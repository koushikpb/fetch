-- CLAUDE.md: "documents is append-only... it never mutates ingested source data." Criterion
-- 2 says "no UPDATE path in the codebase" — a claim no reviewer can verify by reading a
-- diff and one that silently rots. A trigger that raises on both UPDATE and DELETE makes
-- append-only a database guarantee instead of a convention; tests/db/schema.test.ts proves
-- it by attempting each and asserting the failure.
CREATE OR REPLACE FUNCTION documents_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'documents is append-only: % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER documents_no_update
  BEFORE UPDATE ON documents
  FOR EACH ROW EXECUTE FUNCTION documents_append_only();

CREATE TRIGGER documents_no_delete
  BEFORE DELETE ON documents
  FOR EACH ROW EXECUTE FUNCTION documents_append_only();
