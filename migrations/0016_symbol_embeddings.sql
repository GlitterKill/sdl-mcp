-- Migration 0016: Symbol embeddings for semantic search

CREATE TABLE IF NOT EXISTS symbol_embeddings (
  symbol_id TEXT PRIMARY KEY,
  model TEXT NOT NULL,
  embedding_vector BLOB NOT NULL,
  version TEXT NOT NULL,
  card_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(symbol_id) REFERENCES symbols(symbol_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_symbol_embeddings_model ON symbol_embeddings(model);
