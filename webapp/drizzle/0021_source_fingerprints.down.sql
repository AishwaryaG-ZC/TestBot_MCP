-- Migration DOWN: 0021_source_fingerprints
-- Reverses 0021_source_fingerprints.sql.

DROP INDEX IF EXISTS "src_fingerprints_lookup";
DROP TABLE IF EXISTS "project_source_fingerprints";
