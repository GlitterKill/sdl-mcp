-- ML-D.2: Add language field to symbol records

-- Add language column to symbols table
ALTER TABLE symbols ADD COLUMN language TEXT;

-- Backfill existing symbols with language based on file extension
-- Infer language from file's extension by joining with files table
UPDATE symbols
SET language = (
  CASE
    WHEN substr(f.rel_path, -3) = '.ts' THEN 'typescript'
    WHEN substr(f.rel_path, -4) = '.tsx' THEN 'typescript'
    WHEN substr(f.rel_path, -3) = '.js' THEN 'javascript'
    WHEN substr(f.rel_path, -4) = '.jsx' THEN 'typescript'
    WHEN substr(f.rel_path, -3) = '.py' THEN 'python'
    WHEN substr(f.rel_path, -3) = '.go' THEN 'go'
    WHEN substr(f.rel_path, -5) = '.java' THEN 'java'
    WHEN substr(f.rel_path, -6) = '.cs' THEN 'csharp'
    WHEN substr(f.rel_path, -3) = '.cs' THEN 'csharp'
    ELSE f.language
  END
)
FROM files f
WHERE symbols.file_id = f.file_id AND symbols.language IS NULL;

-- Add index on language column for query performance
CREATE INDEX IF NOT EXISTS idx_symbols_language ON symbols(language);
CREATE INDEX IF NOT EXISTS idx_symbols_repo_language ON symbols(repo_id, language);
