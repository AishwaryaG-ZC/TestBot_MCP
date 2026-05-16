-- Migration DOWN: 0020_canonical_suites
-- Reverses 0020_canonical_suites.sql.

DROP INDEX IF EXISTS "canonical_suites_lookup";
DROP TABLE IF EXISTS "project_canonical_suites";
