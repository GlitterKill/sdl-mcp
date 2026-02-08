CREATE TABLE IF NOT EXISTS versions (
  version_id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  reason TEXT,
  FOREIGN KEY(repo_id) REFERENCES repos(repo_id)
);

CREATE TABLE IF NOT EXISTS symbol_versions (
  version_id TEXT NOT NULL,
  symbol_id TEXT NOT NULL,
  ast_fingerprint TEXT NOT NULL,
  signature_json TEXT,
  summary TEXT,
  invariants_json TEXT,
  side_effects_json TEXT,
  PRIMARY KEY(version_id, symbol_id),
  FOREIGN KEY(version_id) REFERENCES versions(version_id)
);

CREATE INDEX IF NOT EXISTS idx_versions_repo ON versions(repo_id, created_at);
CREATE INDEX IF NOT EXISTS idx_symbol_versions_symbol ON symbol_versions(symbol_id);
