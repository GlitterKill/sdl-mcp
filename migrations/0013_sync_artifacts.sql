CREATE TABLE IF NOT EXISTS sync_artifacts (
  artifact_id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  commit_sha TEXT,
  branch TEXT,
  artifact_hash TEXT NOT NULL,
  compressed_data TEXT NOT NULL,
  created_at TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  FOREIGN KEY(repo_id) REFERENCES repos(repo_id),
  FOREIGN KEY(version_id) REFERENCES versions(version_id)
);

CREATE INDEX IF NOT EXISTS idx_sync_artifacts_repo ON sync_artifacts(repo_id);
CREATE INDEX IF NOT EXISTS idx_sync_artifacts_version ON sync_artifacts(version_id);
CREATE INDEX IF NOT EXISTS idx_sync_artifacts_commit ON sync_artifacts(commit_sha);
