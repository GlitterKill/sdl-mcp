CREATE TABLE IF NOT EXISTS agent_feedback (
  feedback_id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  slice_handle TEXT NOT NULL,
  useful_symbols_json TEXT NOT NULL DEFAULT '[]',
  missing_symbols_json TEXT NOT NULL DEFAULT '[]',
  task_tags_json TEXT DEFAULT NULL,
  task_type TEXT,
  task_text TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(repo_id) REFERENCES repos(repo_id) ON DELETE CASCADE,
  FOREIGN KEY(version_id) REFERENCES versions(version_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_agent_feedback_repo ON agent_feedback(repo_id);
CREATE INDEX IF NOT EXISTS idx_agent_feedback_version ON agent_feedback(version_id);
CREATE INDEX IF NOT EXISTS idx_agent_feedback_created ON agent_feedback(created_at);
CREATE INDEX IF NOT EXISTS idx_agent_feedback_slice_handle ON agent_feedback(slice_handle);

CREATE TABLE IF NOT EXISTS symbol_feedback_weights (
  symbol_id TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  positive_count INTEGER NOT NULL DEFAULT 0,
  negative_count INTEGER NOT NULL DEFAULT 0,
  weight_adjustment REAL NOT NULL DEFAULT 0.0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(symbol_id, repo_id),
  FOREIGN KEY(symbol_id) REFERENCES symbols(symbol_id) ON DELETE CASCADE,
  FOREIGN KEY(repo_id) REFERENCES repos(repo_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_symbol_feedback_weights_repo ON symbol_feedback_weights(repo_id);
CREATE INDEX IF NOT EXISTS idx_symbol_feedback_weights_adjustment ON symbol_feedback_weights(weight_adjustment DESC);
