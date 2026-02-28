-- Note: SQLite does not support adding FOREIGN KEY via ALTER TABLE, so
-- referential integrity is enforced at the application layer in queries.ts
-- (deleteSummaryCacheByRepo uses a subquery join against the symbols table).
-- Orphaned rows (from symbols deleted outside that function) will not cascade-
-- delete automatically; run deleteSummaryCacheByRepo to clean up by repo.
CREATE TABLE IF NOT EXISTS symbol_summary_cache (
  symbol_id   TEXT NOT NULL PRIMARY KEY,
  summary     TEXT NOT NULL,
  provider    TEXT NOT NULL,
  model       TEXT NOT NULL,
  card_hash   TEXT NOT NULL,
  cost_usd    REAL NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
