CREATE TABLE IF NOT EXISTS card_hashes (
  card_hash TEXT PRIMARY KEY,
  card_blob TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tool_policy_hashes (
  policy_hash TEXT PRIMARY KEY,
  policy_blob TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tsconfig_hashes (
  tsconfig_hash TEXT PRIMARY KEY,
  tsconfig_blob TEXT NOT NULL,
  created_at TEXT NOT NULL
);

ALTER TABLE versions ADD COLUMN prev_version_hash TEXT;
ALTER TABLE versions ADD COLUMN version_hash TEXT;

UPDATE versions SET prev_version_hash = NULL WHERE prev_version_hash IS NULL;
UPDATE versions SET version_hash = NULL WHERE version_hash IS NULL;

CREATE INDEX IF NOT EXISTS idx_card_hashes_created ON card_hashes(created_at);
CREATE INDEX IF NOT EXISTS idx_tool_policy_hashes_created ON tool_policy_hashes(created_at);
CREATE INDEX IF NOT EXISTS idx_tsconfig_hashes_created ON tsconfig_hashes(created_at);
CREATE INDEX IF NOT EXISTS idx_versions_version_hash ON versions(version_hash);
CREATE INDEX IF NOT EXISTS idx_versions_prev_hash ON versions(prev_version_hash);
