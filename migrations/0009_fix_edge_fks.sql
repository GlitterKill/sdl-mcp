-- RR-G.7: Add missing foreign key constraints to edges table
-- Note: to_symbol_id intentionally has no FK constraint because the indexer
-- creates "unresolved" edges (e.g., "unresolved:call:functionName") for
-- cross-file references that haven't been resolved yet.

-- Create new edges table with proper FK constraints
CREATE TABLE edges_new (
  edge_id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id TEXT NOT NULL,
  from_symbol_id TEXT NOT NULL,
  to_symbol_id TEXT NOT NULL,
  type TEXT NOT NULL,
  weight REAL NOT NULL,
  provenance TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(repo_id) REFERENCES repos(repo_id) ON DELETE CASCADE,
  FOREIGN KEY(from_symbol_id) REFERENCES symbols(symbol_id) ON DELETE CASCADE
  -- to_symbol_id has no FK: allows unresolved edges like "unresolved:call:foo"
);

-- Copy only valid data (with existing FK references) from old table
-- Only validate repo_id and from_symbol_id; to_symbol_id may be unresolved
INSERT INTO edges_new
SELECT e.* FROM edges e
WHERE EXISTS (SELECT 1 FROM repos r WHERE r.repo_id = e.repo_id)
  AND EXISTS (SELECT 1 FROM symbols s WHERE s.symbol_id = e.from_symbol_id);

-- Drop old table
DROP TABLE edges;

-- Rename new table
ALTER TABLE edges_new RENAME TO edges;

-- Recreate indexes
CREATE INDEX idx_edges_repo_from ON edges(from_symbol_id);
CREATE INDEX idx_edges_repo_to ON edges(to_symbol_id);
CREATE INDEX idx_edges_repo ON edges(repo_id);
