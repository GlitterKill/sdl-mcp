CREATE INDEX IF NOT EXISTS idx_edges_repo_type ON edges(repo_id, type);
CREATE INDEX IF NOT EXISTS idx_edges_from_to ON edges(from_symbol_id, to_symbol_id);
