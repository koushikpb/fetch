-- Must run before 0001 creates any `vector` columns (embeddings.vector, clusters.centroid).
-- `IF NOT EXISTS` is what lets this migration apply to a genuinely empty Postgres database
-- (task criterion 1) without assuming the extension was pre-installed out of band.
CREATE EXTENSION IF NOT EXISTS vector;
