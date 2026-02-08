-- Migration 0012: Create symbol_references table for inverted index
-- This table tracks symbol references in test files for O(1) lookup

CREATE TABLE IF NOT EXISTS symbol_references (
  ref_id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id TEXT NOT NULL,
  symbol_name TEXT NOT NULL,
  file_id INTEGER NOT NULL,
  line_number INTEGER,
  created_at TEXT NOT NULL,
  FOREIGN KEY(repo_id) REFERENCES repos(repo_id) ON DELETE CASCADE,
  FOREIGN KEY(file_id) REFERENCES files(file_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_symbol_refs_name ON symbol_references(repo_id, symbol_name);
CREATE INDEX IF NOT EXISTS idx_symbol_refs_file ON symbol_references(file_id);
