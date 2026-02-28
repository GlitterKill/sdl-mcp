-- Migration 0020: deduplicate edges and add unique constraint on natural key
--
-- Background: the edges table had no UNIQUE constraint on
-- (from_symbol_id, to_symbol_id, type), so concurrent indexing passes
-- (e.g. pass-1 tree-sitter + pass-2 TS call resolver) could insert
-- duplicate rows for the same logical edge.  For the sdl-mcp repo this
-- inflated importEdgeCount by ~75 % vs the pre-v0.6.9b baseline, causing
-- sliceBuildTimeMs to regress past the CI guardrail.
--
-- Fix: deduplicate existing rows (keep the one with highest confidence /
-- most specific resolution_strategy), then add the unique constraint.
-- createEdge() in queries.ts is updated to INSERT OR IGNORE.

-- Step 1: delete lower-quality duplicates.
-- We keep the row with the lowest edge_id among ties (stable, reproducible).
DELETE FROM edges
WHERE edge_id NOT IN (
  SELECT MIN(edge_id)
  FROM edges
  GROUP BY from_symbol_id, to_symbol_id, type
);

-- Step 2: add unique index (enforces the constraint going forward).
-- Using CREATE UNIQUE INDEX rather than ALTER TABLE so it is safe to run
-- against SQLite versions that don't support ADD CONSTRAINT.
CREATE UNIQUE INDEX IF NOT EXISTS idx_edges_natural_key
  ON edges(from_symbol_id, to_symbol_id, type);
