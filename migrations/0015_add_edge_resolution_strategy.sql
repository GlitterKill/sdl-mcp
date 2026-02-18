-- Migration 0015: Add resolution strategy metadata for call edges

ALTER TABLE edges ADD COLUMN resolution_strategy TEXT DEFAULT 'exact';

CREATE INDEX idx_edges_resolution_strategy ON edges(resolution_strategy);
