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
