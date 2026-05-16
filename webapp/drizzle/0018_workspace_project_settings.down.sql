-- Migration DOWN: 0018_workspace_project_settings
-- Reverses 0018_workspace_project_settings.sql.

DROP INDEX IF EXISTS "ws_project_settings_workspace_idx";
DROP TABLE IF EXISTS "workspace_project_settings";
