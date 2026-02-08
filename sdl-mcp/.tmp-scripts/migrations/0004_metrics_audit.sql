CREATE TABLE IF NOT EXISTS metrics (
  symbol_id TEXT PRIMARY KEY,
  fan_in INTEGER NOT NULL DEFAULT 0,
  fan_out INTEGER NOT NULL DEFAULT 0,
  churn_30d INTEGER NOT NULL DEFAULT 0,
  test_refs_json TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(symbol_id) REFERENCES symbols(symbol_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS audit (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  tool TEXT NOT NULL,
  decision TEXT NOT NULL,
  repo_id TEXT,
  symbol_id TEXT,
  details_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_tool ON audit(tool);
CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit(timestamp);
CREATE INDEX IF NOT EXISTS idx_audit_repo ON audit(repo_id);
