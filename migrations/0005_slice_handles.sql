CREATE TABLE IF NOT EXISTS slice_handles (
  handle TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  min_version TEXT,
  max_version TEXT,
  slice_hash TEXT NOT NULL,
  spillover_ref TEXT,
  FOREIGN KEY(repo_id) REFERENCES repos(repo_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_slice_handles_repo ON slice_handles(repo_id);
CREATE INDEX IF NOT EXISTS idx_slice_handles_expires ON slice_handles(expires_at);
CREATE INDEX IF NOT EXISTS idx_slice_handles_repo_version ON slice_handles(repo_id, max_version);
