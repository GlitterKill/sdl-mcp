PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;

CREATE TABLE IF NOT EXISTS repos (
  repo_id TEXT PRIMARY KEY,
  root_path TEXT NOT NULL,
  config_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS files (
  file_id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id TEXT NOT NULL,
  rel_path TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  language TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  last_indexed_at TEXT,
  UNIQUE(repo_id, rel_path),
  FOREIGN KEY(repo_id) REFERENCES repos(repo_id)
);

CREATE TABLE IF NOT EXISTS symbols (
  symbol_id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  file_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  exported INTEGER NOT NULL,
  visibility TEXT,
  range_start_line INTEGER NOT NULL,
  range_start_col INTEGER NOT NULL,
  range_end_line INTEGER NOT NULL,
  range_end_col INTEGER NOT NULL,
  ast_fingerprint TEXT NOT NULL,
  signature_json TEXT,
  summary TEXT,
  invariants_json TEXT,
  side_effects_json TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(repo_id) REFERENCES repos(repo_id),
  FOREIGN KEY(file_id) REFERENCES files(file_id)
);

CREATE TABLE IF NOT EXISTS edges (
  edge_id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id TEXT NOT NULL,
  from_symbol_id TEXT NOT NULL,
  to_symbol_id TEXT NOT NULL,
  type TEXT NOT NULL,
  weight REAL NOT NULL,
  provenance TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(repo_id) REFERENCES repos(repo_id)
);

CREATE TABLE IF NOT EXISTS versions (
  version_id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  version_number INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  prev_version_hash TEXT,
  version_hash TEXT NOT NULL,
  FOREIGN KEY(repo_id) REFERENCES repos(repo_id)
);

CREATE TABLE IF NOT EXISTS symbol_versions (
  symbol_version_id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  version_hash TEXT NOT NULL,
  FOREIGN KEY(symbol_id) REFERENCES symbols(symbol_id),
  FOREIGN KEY(version_id) REFERENCES versions(version_id)
);

CREATE TABLE IF NOT EXISTS metrics (
  symbol_id TEXT PRIMARY KEY,
  fan_in INTEGER NOT NULL,
  fan_out INTEGER NOT NULL,
  churn_30d INTEGER NOT NULL,
  test_refs_json TEXT,
  FOREIGN KEY(symbol_id) REFERENCES symbols(symbol_id)
);

CREATE TABLE IF NOT EXISTS audit_log (
  audit_id INTEGER PRIMARY KEY AUTOINCREMENT,
  audit_hash TEXT NOT NULL UNIQUE,
  timestamp TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  tool_version TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  decision TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  FOREIGN KEY(repo_id) REFERENCES repos(repo_id)
);

CREATE TABLE IF NOT EXISTS slice_handles (
  handle TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  min_version TEXT,
  max_version TEXT NOT NULL,
  slice_hash TEXT NOT NULL,
  spillover_ref TEXT,
  FOREIGN KEY(repo_id) REFERENCES repos(repo_id)
);

CREATE TABLE IF NOT EXISTS card_hashes (
  card_hash TEXT PRIMARY KEY,
  symbol_id TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  ledger_version TEXT NOT NULL,
  hash_data TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(symbol_id) REFERENCES symbols(symbol_id),
  FOREIGN KEY(repo_id) REFERENCES repos(repo_id),
  FOREIGN KEY(version_id) REFERENCES versions(version_id)
);
