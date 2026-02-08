-- Add performance indexes for frequently queried columns
-- Migration: 0008_performance_indexes.sql

-- Index for getSymbolsByFile() - frequently called during indexing
CREATE INDEX IF NOT EXISTS idx_symbols_file_id ON symbols(file_id);

-- Index for searchSymbols() - improves LIKE queries on name with repo_id filter
CREATE INDEX IF NOT EXISTS idx_symbols_repo_name_idx ON symbols(repo_id, name);

-- Index for getFilesByRepo() - frequently called during operations
CREATE INDEX IF NOT EXISTS idx_files_repo_id ON files(repo_id);

-- Index for version queries with ordering by created_at
-- Covers getLatestVersion() and listVersions()
CREATE INDEX IF NOT EXISTS idx_versions_repo_created ON versions(repo_id, created_at DESC);

-- Index for slice_handles by repo_id
CREATE INDEX IF NOT EXISTS idx_slice_handles_repo_id ON slice_handles(repo_id);

-- Composite index for symbols with repo_id and kind (common filter combo)
CREATE INDEX IF NOT EXISTS idx_symbols_repo_kind ON symbols(repo_id, kind);
