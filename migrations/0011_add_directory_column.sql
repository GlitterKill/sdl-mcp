-- Migration: Add directory column to files table
-- Purpose: Improve performance of directory aggregate queries by storing computed directory

-- Add directory column
ALTER TABLE files ADD COLUMN directory TEXT NOT NULL DEFAULT '';

-- Populate existing rows with directory from rel_path
-- Extract directory by finding the last slash (like JavaScript's lastIndexOf)
-- Using reverse() to find the last occurrence of '/'
-- Formula: substr(rel_path, 1, length(rel_path) - instr(reverse(rel_path), '/'))
-- Note: instr() is 1-indexed in SQLite, so we don't need to adjust further
UPDATE files SET directory =
  CASE
    WHEN instr(rel_path, '/') > 0
    THEN substr(rel_path, 1, length(rel_path) - instr(reverse(rel_path), '/'))
    ELSE ''
  END;

-- Add index for directory queries (composite with repo_id for better filtering)
CREATE INDEX idx_files_directory ON files(repo_id, directory);
