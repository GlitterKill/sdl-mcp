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

CREATE INDEX IF NOT EXISTS idx_symbols_repo_file ON symbols(repo_id, file_id);
CREATE INDEX IF NOT EXISTS idx_symbols_repo_name ON symbols(repo_id, name);

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

CREATE INDEX IF NOT EXISTS idx_edges_repo_from ON edges(repo_id, from_symbol_id);
CREATE INDEX IF NOT EXISTS idx_edges_repo_to ON edges(repo_id, to_symbol_id);
