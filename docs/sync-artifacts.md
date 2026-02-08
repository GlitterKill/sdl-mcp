# Sync Artifact and Import/Export Flow

## Overview

The sync artifact system enables CI-produced memory artifacts to be exported, imported, and shared across environments. This provides:

- **Deterministic restore**: Indexed state can be restored exactly from artifacts
- **Commit traceability**: Artifacts link to Git commit SHAs and branches
- **Fast bootstrap**: Consumers can pull latest state without full re-indexing
- **Explicit failure handling**: Retry/fallback behavior for sync failures

## Architecture

### Core Components

- **SyncArtifact**: Stores compressed indexed state with metadata
- **Export**: Creates artifacts from current indexed state
- **Import**: Restores indexed state from artifacts
- **Pull**: Fetches latest artifact or falls back to full index

### Data Model

```typescript
interface SyncArtifact {
  artifact_id: string;
  repo_id: string;
  version_id: string;
  commit_sha: string | null;
  branch: string | null;
  artifact_hash: string;
  compressed_data: string;
  created_at: string;
  size_bytes: number;
}
```

## Usage

### CLI Commands

#### Export Indexed State

```bash
# Export latest indexed state
sdl-mcp export

# Export with commit SHA linking
sdl-mcp export --commit-sha abc123def456 --branch main

# Export specific version
sdl-mcp export --version-id repo-v1234567890

# Export to custom path
sdl-mcp export --output ./artifacts/my-repo.sdl-artifact.json

# List available artifacts
sdl-mcp export --list
```

#### Import Indexed State

```bash
# Import from artifact (with integrity verification)
sdl-mcp import --artifact-path ./artifacts/my-repo.sdl-artifact.json

# Import with force flag (ignore repo_id mismatch)
sdl-mcp import --artifact-path ./artifacts/my-repo.sdl-artifact.json --force

# Import without verification
sdl-mcp import --artifact-path ./artifacts/my-repo.sdl-artifact.json --verify false
```

#### Pull Latest State

```bash
# Pull latest state (from artifact or fallback to index)
sdl-mcp pull

# Pull specific commit's artifact
sdl-mcp pull --commit-sha abc123def456

# Pull specific version
sdl-mcp pull --version-id repo-v1234567890

# Disable fallback to full index
sdl-mcp pull --fallback false

# Configure retry attempts
sdl-mcp pull --retries 5
```

### Programmatic API

#### Export Artifact

```typescript
import { exportArtifact } from "./sync/sync.js";

const result = await exportArtifact({
  repoId: "my-repo",
  commitSha: "abc123def456",
  branch: "main",
  outputPath: "./artifacts/my-repo.sdl-artifact.json",
});

console.log(`Exported: ${result.artifactId}`);
console.log(`Files: ${result.fileCount}, Symbols: ${result.symbolCount}`);
```

#### Import Artifact

```typescript
import { importArtifact } from "./sync/sync.js";

const result = await importArtifact({
  artifactPath: "./artifacts/my-repo.sdl-artifact.json",
  repoId: "my-repo",
  verifyIntegrity: true,
});

console.log(
  `Restored: ${result.filesRestored} files, ${result.symbolsRestored} symbols`,
);
```

#### Pull with Fallback

```typescript
import { pullWithFallback } from "./sync/pull.js";

const result = await pullWithFallback({
  repoId: "my-repo",
  commitSha: "abc123def456",
  fallbackToFullIndex: true,
  maxRetries: 3,
});

if (result.success) {
  console.log(`Pulled version: ${result.versionId} via ${result.method}`);
} else {
  console.error(`Failed: ${result.error}`);
}
```

## CI Integration

### Export Artifacts in CI

```yaml
- name: Index Codebase
  run: |
    sdl-mcp init
    sdl-mcp index

- name: Export Sync Artifact
  run: |
    sdl-mcp export \
      --commit-sha ${{ github.sha }} \
      --branch ${{ github.ref_name }} \
      --output ./artifacts/${{ github.sha }}.sdl-artifact.json

- name: Upload Artifact
  uses: actions/upload-artifact@v3
  with:
    name: sync-artifact
    path: ./artifacts/*.sdl-artifact.json
```

### Import Artifacts in CI

```yaml
- name: Download Artifact
  uses: actions/download-artifact@v3
  with:
    name: sync-artifact
    path: ./artifacts/

- name: Import Indexed State
  run: |
    sdl-mcp import --artifact-path ./artifacts/${{ github.sha }}.sdl-artifact.json
```

## Artifact Format

Artifacts are compressed JSON files containing:

1. **Metadata**: Repo ID, version ID, commit SHA, branch
2. **Indexed State**: Files, symbols, edges, metrics
3. **Integrity Hash**: SHA256 of uncompressed state for verification

### Artifact Structure

```json
{
  "artifact_id": "my-repo-abc123def456-a1b2c3d4e5f6",
  "repo_id": "my-repo",
  "version_id": "my-repo-v1234567890",
  "commit_sha": "abc123def456",
  "branch": "main",
  "artifact_hash": "sha256:...",
  "compressed_data": "base64-encoded-gzip-compressed-json",
  "created_at": "2025-02-08T12:00:00.000Z",
  "size_bytes": 123456
}
```

## Error Handling

### Retry Strategy

The pull command implements exponential backoff retry:

```typescript
// Default: 3 retries with exponential backoff
const result = await pullWithFallback({
  repoId: "my-repo",
  maxRetries: 3,
});
```

### Fallback Behavior

When no artifact is found:

1. **With fallback** (default): Performs full index operation
2. **Without fallback**: Returns error with explicit message

### Integrity Failures

Import with verification will fail if:

- Artifact hash doesn't match content
- Decompression fails
- JSON parsing fails
- Missing required fields

## Performance Considerations

### Artifact Size

Artifacts are gzip-compressed. Typical sizes:

- Small repo (< 100 files): 10-50 KB
- Medium repo (100-1000 files): 50-500 KB
- Large repo (> 1000 files): 500 KB - 5 MB

### Export/Import Speed

- Export: ~10-100ms per file (depends on symbol count)
- Import: ~5-50ms per file (faster due to no parsing)

### Pull vs Full Index

- Artifact pull: 100-1000x faster than full index
- Full index fallback: Same speed as `sdl-mcp index`

## Security

### Integrity Verification

All imports verify:

1. Artifact hash matches decompressed content
2. Required fields present
3. Valid JSON structure

### Artifact Tampering

Modified artifacts will fail integrity verification with clear error:

```
Import failed: Artifact integrity check failed: hash mismatch
```

## Deterministic Restore

The same indexed state exported multiple times produces identical artifacts:

- Same commit SHA → same artifact ID
- Same version hash → same artifact hash
- Same content → identical compressed data

This enables artifact deduplication and caching.

## Troubleshooting

### "No sync artifact found"

Ensure:

1. Artifact file exists in expected location
2. Artifact path is correct
3. Commit SHA or version ID matches

### "Artifact integrity check failed"

Possible causes:

1. Artifact file corrupted
2. Artifact modified after export
3. Incorrect artifact file

Solution: Re-export artifact with `sdl-mcp export`

### "Repository not found"

Ensure:

1. Repository is registered: `sdl-mcp init`
2. Repository ID is correct
3. Database is accessible

### "Import failed: repo_id does not match"

Solution: Use `--force` flag to override repo_id check:

```bash
sdl-mcp import --artifact-path artifact.json --force
```

## Best Practices

### CI/CD

1. **Export after index**: Always export immediately after indexing
2. **Link to commits**: Always include commit SHA for traceability
3. **Upload artifacts**: Store artifacts in CI artifact storage
4. **Version artifacts**: Include commit SHA in artifact filename

### Development

1. **Pull before index**: Try `sdl-mcp pull` before full index
2. **Use fallbacks**: Enable fallback to handle missing artifacts
3. **Verify integrity**: Always import with verification enabled
4. **List artifacts**: Use `--list` to see available artifacts

### Storage

1. **Organize artifacts**: Store in dedicated directory (e.g., `.sdl-sync/`)
2. **Clean old artifacts**: Remove artifacts older than N commits
3. **Track artifacts**: Use commit SHAs for artifact naming
4. **Compress artifacts**: Already compressed by default (gzip)

## Migration

### From Previous Version

No migration needed. Sync artifacts are self-contained and can be used across versions.

### Database Schema

New migration adds `sync_artifacts` table:

```sql
CREATE TABLE sync_artifacts (
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
```

Run `npm run migrate` to apply migration.
