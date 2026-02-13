-- Migration 0014: Add confidence scoring to edges
-- Enables agents to filter edges by resolution certainty

-- Add confidence column with default 1.0 (existing edges are trusted)
ALTER TABLE edges ADD COLUMN confidence REAL DEFAULT 1.0;

-- Create index for filtering by confidence
CREATE INDEX idx_edges_confidence ON edges(confidence);

-- Add check constraint to ensure valid range
-- Note: SQLite doesn't enforce CHECK constraints by default, but we include for documentation
-- Valid range: 0.0 to 1.0
-- 
-- Confidence levels:
-- 1.0 = TS Compiler API resolved
-- 0.9 = Import-trace resolved
-- 0.8 = Same-file symbol match
-- 0.6 = Class method heuristic
-- 0.3 = Unresolved
