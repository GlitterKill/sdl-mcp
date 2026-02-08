-- RR-H.1: Database schema standardization

-- Issue 1: Add missing FK on symbol_versions.symbol_id with CASCADE
-- Recreate symbol_versions table with proper FK constraint
CREATE TABLE symbol_versions_new (
  version_id TEXT NOT NULL,
  symbol_id TEXT NOT NULL,
  ast_fingerprint TEXT NOT NULL,
  signature_json TEXT,
  summary TEXT,
  invariants_json TEXT,
  side_effects_json TEXT,
  PRIMARY KEY(version_id, symbol_id),
  FOREIGN KEY(version_id) REFERENCES versions(version_id) ON DELETE CASCADE,
  FOREIGN KEY(symbol_id) REFERENCES symbols(symbol_id) ON DELETE CASCADE
);

-- Copy only valid data (with existing FK references) from old table
INSERT INTO symbol_versions_new
SELECT sv.* FROM symbol_versions sv
WHERE EXISTS (SELECT 1 FROM versions v WHERE v.version_id = sv.version_id)
  AND EXISTS (SELECT 1 FROM symbols s WHERE s.symbol_id = sv.symbol_id);

-- Drop old table
DROP TABLE symbol_versions;

-- Rename new table
ALTER TABLE symbol_versions_new RENAME TO symbol_versions;

-- Recreate index
CREATE INDEX idx_symbol_versions_symbol ON symbol_versions(symbol_id);

-- Issue 3: Remove duplicate index idx_symbols_repo_name_idx from migration 0008
-- (idx_symbols_repo_name already exists from migration 0001)
DROP INDEX IF EXISTS idx_symbols_repo_name_idx;
