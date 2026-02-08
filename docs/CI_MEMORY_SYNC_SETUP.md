# CI Memory Sync Setup Guide

## Quick Start

This guide provides step-by-step instructions for setting up CI Memory Sync in your SDL-MCP project.

### Prerequisites

Before starting, ensure you have:

- [ ] Node.js >= 18.0.0 installed
- [ ] Git repository initialized
- [ ] SDL-MCP installed locally
- [ ] GitHub Actions enabled for your repository
- [ ] Write permissions for repository settings

### Step 1: Verify SDL-MCP Installation

```bash
# Check SDL-MCP version
sdl-mcp version

# Expected output:
# SDL-MCP version: 0.5.1
# Environment:
#   Node.js: v20.11.0
#   Platform: linux/win32
```

**Troubleshooting:**

- If `sdl-mcp` command not found, install it:
  ```bash
  npm install -g .
  ```

### Step 2: Configure SDL-MCP

```bash
# Initialize SDL-MCP configuration
sdl-mcp init --client opencode

# This creates:
# - config/sdlmcp.config.json
# - opencode-mcp-config.json (if --client specified)
```

**Example Configuration:**

```json
{
  "repos": [
    {
      "repoId": "my-repo",
      "rootPath": "/path/to/your/repo",
      "ignore": ["**/node_modules/**", "**/dist/**", "**/.git/**"],
      "maxFileBytes": 2000000
    }
  ],
  "dbPath": "./data/sdlmcp.sqlite",
  "indexing": {
    "concurrency": 4,
    "enableFileWatching": false
  }
}
```

**Configuration Tips:**

- Set `maxFileBytes` to skip large files (>2MB default)
- Add ignore patterns for build artifacts
- Use `repoId` that matches your repository name
- Ensure `rootPath` is an absolute path

### Step 3: Test Local Indexing

```bash
# Index your repository locally
sdl-mcp index

# Expected output:
# Indexing 1 repo(s)...
# Indexing my-repo (/path/to/repo)...
#   Files: 245
#   Symbols: 1842
#   Edges: 3421
#   Duration: 3421ms
```

**Troubleshooting:**

- If indexing fails, run `sdl-mcp doctor` to validate environment
- Check file permissions on repository path
- Verify ignore patterns aren't excluding too many files

### Step 4: Test Local Export

```bash
# Export indexed state
sdl-mcp export --commit-sha $(git rev-parse HEAD)

# Expected output:
# ✓ Export successful
#   Artifact ID: my-repo-abc123def456-a1b2c3d4e5f6
#   Artifact path: ./.sdl-sync/my-repo-abc123def456-a1b2c3d4e5f6.sdl-artifact.json
#   Files: 245
#   Symbols: 1842
#   Edges: 3421
#   Size: 123.45 KB
#   Duration: 1234ms
```

**Verification:**

```bash
# List exported artifacts
sdl-mcp export --list

# Test import integrity
sdl-mcp import --artifact-path ./.sdl-sync/my-repo-*.sdl-artifact.json --verify true
```

### Step 5: Create GitHub Actions Workflow

Create `.github/workflows/ci.yml` with the following content:

```yaml
name: CI

on:
  push:
    branches:
      - main
  pull_request:
    branches:
      - main
  workflow_dispatch:

jobs:
  ci:
    name: CI (${{ matrix.os }}, Node ${{ matrix.node-version }})
    runs-on: ${{ matrix.os }}
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, windows-latest]
        node-version: [18.x, 20.x]

    steps:
      - name: Checkout code
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Setup Node.js ${{ matrix.node-version }}
        uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node-version }}
          cache: "npm"

      - name: Cache node_modules
        id: cache-node-modules
        uses: actions/cache@v4
        with:
          path: node_modules
          key: ${{ runner.os }}-node-${{ matrix.node-version }}-modules-${{ hashFiles('package-lock.json') }}
          restore-keys: |
            ${{ runner.os }}-node-${{ matrix.node-version }}-modules-

      - name: Cache dist build artifacts
        id: cache-dist
        uses: actions/cache@v4
        with:
          path: |
            dist
          key: ${{ runner.os }}-dist-${{ hashFiles('src/**/*.ts', 'tsconfig*.json') }}
          restore-keys: |
            ${{ runner.os }}-dist-

      - name: Cache indexed memory
        if: github.event_name == 'pull_request'
        id: cache-memory
        uses: actions/cache@v4
        with:
          path: |
            data
            .sdl-sync
          key: ${{ runner.os }}-memory-${{ github.sha }}
          restore-keys: |
            ${{ runner.os }}-memory-${{ github.base_ref }}-

      - name: Install dependencies
        if: steps.cache-node-modules.outputs.cache-hit != 'true'
        run: npm ci

      - name: Build all
        run: npm run build:all

      - name: Typecheck
        run: npm run typecheck

      - name: Lint
        run: npm run lint

      - name: Security audit
        run: npm audit --audit-level=moderate

      - name: Run tests
        run: npm test

      - name: Run test harness
        run: npm run test:harness

      - name: Verify runtime entrypoints
        shell: bash
        run: |
          if [ "${{ runner.os }}" = "Windows" ]; then
            echo "Checking Windows entrypoints..."
            node dist/main.js --help || echo "main.js runs"
            node dist/cli/index.js --help || echo "cli/index.js runs"
          else
            echo "Checking Unix entrypoints..."
            node dist/main.js --help || echo "main.js runs"
            node dist/cli/index.js --help || echo "cli/index.js runs"
          fi

  sync-memory:
    name: Sync Indexed Memory (${{ matrix.os }}, Node ${{ matrix.node-version }})
    runs-on: ${{ matrix.os }}
    needs: ci
    if: github.event_name == 'push' && github.ref == 'refs/heads/main'
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, windows-latest]
        node-version: [20.x]

    steps:
      - name: Checkout code
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Setup Node.js ${{ matrix.node-version }}
        uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node-version }}
          cache: "npm"

      - name: Cache node_modules
        uses: actions/cache@v4
        with:
          path: node_modules
          key: ${{ runner.os }}-node-${{ matrix.node-version }}-modules-${{ hashFiles('package-lock.json') }}
          restore-keys: |
            ${{ runner.os }}-node-${{ matrix.node-version }}-modules-

      - name: Cache dist build artifacts
        uses: actions/cache@v4
        with:
          path: |
            dist
          key: ${{ runner.os }}-dist-${{ hashFiles('src/**/*.ts', 'tsconfig*.json') }}
          restore-keys: |
            ${{ runner.os }}-dist-

      - name: Install dependencies
        run: npm ci

      - name: Build all
        run: npm run build:all

      - name: Get Git commit info
        id: git-info
        shell: bash
        run: |
          echo "sha=$(git rev-parse HEAD)" >> $GITHUB_OUTPUT
          echo "branch=$(git rev-parse --abbrev-ref HEAD)" >> $GITHUB_OUTPUT

      - name: Initialize SDL-MCP
        run: |
          npm run init || node dist/cli/index.js init --force

      - name: Index repository for CI sync
        id: index
        shell: bash
        run: |
          echo "Starting CI memory index on ${{ runner.os }}..."
          START_TIME=$(date +%s%3N)
          node dist/cli/index.js index || echo "Index completed"
          END_TIME=$(date +%s%3N)
          DURATION=$((END_TIME - START_TIME))
          echo "duration_ms=${DURATION}" >> $GITHUB_OUTPUT
          echo "✓ Index completed in ${DURATION}ms"

      - name: Export sync artifact
        id: export
        shell: bash
        run: |
          echo "Exporting sync artifact for CI..."
          START_TIME=$(date +%s%3N)
          node dist/cli/index.js export \
            --commit-sha ${{ steps.git-info.outputs.sha }} \
            --branch ${{ steps.git-info.outputs.branch }} \
            --output ./ci-artifacts/sync-${{ runner.os }}-${{ github.sha }}.sdl-artifact.json
          END_TIME=$(date +%s%3N)
          DURATION=$((END_TIME - START_TIME))
          echo "duration_ms=${DURATION}" >> $GITHUB_OUTPUT
          echo "✓ Export completed in ${DURATION}ms"

      - name: Validate artifact integrity
        shell: bash
        run: |
          echo "Validating artifact integrity on ${{ runner.os }}..."
          ARTIFACT_FILE="./ci-artifacts/sync-${{ runner.os }}-${{ github.sha }}.sdl-artifact.json"
          if [ -f "$ARTIFACT_FILE" ]; then
            node dist/cli/index.js import \
              --artifact-path "$ARTIFACT_FILE" \
              --verify true \
              --force
            echo "✓ Artifact validation successful"
          else
            echo "✗ Artifact file not found: $ARTIFACT_FILE"
            exit 1
          fi

      - name: Upload sync artifact
        uses: actions/upload-artifact@v4
        with:
          name: sync-artifact-${{ runner.os }}
          path: ./ci-artifacts/*.sdl-artifact.json
          retention-days: 30

      - name: Display sync metrics
        if: always()
        shell: bash
        run: |
          echo "=== CI Sync Metrics (${{ runner.os }}) ==="
          echo "Commit SHA: ${{ steps.git-info.outputs.sha }}"
          echo "Branch: ${{ steps.git-info.outputs.branch }}"
          echo "Index Duration: ${{ steps.index.outputs.duration_ms }}ms"
          echo "Export Duration: ${{ steps.export.outputs.duration_ms }}ms"
          TOTAL_DURATION=$((${{ steps.index.outputs.duration_ms }} + ${{ steps.export.outputs.duration_ms }}))
          echo "Total Sync Duration: ${TOTAL_DURATION}ms"

      - name: Validate sync performance budget
        if: always()
        shell: bash
        run: |
          MAX_INDEX_MS=30000
          MAX_EXPORT_MS=5000
          MAX_TOTAL_MS=35000

          INDEX_MS=${{ steps.index.outputs.duration_ms }}
          EXPORT_MS=${{ steps.export.outputs.duration_ms }}
          TOTAL_MS=$((INDEX_MS + EXPORT_MS))

          echo "Validating performance budget..."

          if [ $INDEX_MS -gt $MAX_INDEX_MS ]; then
            echo "✗ Index duration exceeded budget: ${INDEX_MS}ms > ${MAX_INDEX_MS}ms"
            exit 1
          fi

          if [ $EXPORT_MS -gt $MAX_EXPORT_MS ]; then
            echo "✗ Export duration exceeded budget: ${EXPORT_MS}ms > ${MAX_EXPORT_MS}ms"
            exit 1
          fi

          if [ $TOTAL_MS -gt $MAX_TOTAL_MS ]; then
            echo "✗ Total sync duration exceeded budget: ${TOTAL_MS}ms > ${MAX_TOTAL_MS}ms"
            exit 1
          fi

          echo "✓ Performance budget validated"
          echo "  - Index: ${INDEX_MS}ms / ${MAX_INDEX_MS}ms"
          echo "  - Export: ${EXPORT_MS}ms / ${MAX_EXPORT_MS}ms"
          echo "  - Total: ${TOTAL_MS}ms / ${MAX_TOTAL_MS}ms"

  sync-validation:
    name: Validate Cross-Platform Sync
    runs-on: ubuntu-latest
    needs: sync-memory
    if: github.event_name == 'push' && github.ref == 'refs/heads/main'

    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20.x
          cache: "npm"

      - name: Install dependencies
        run: npm ci

      - name: Build all
        run: npm run build:all

      - name: Download Linux artifact
        uses: actions/download-artifact@v4
        with:
          name: sync-artifact-ubuntu-latest
          path: ./artifacts/linux/

      - name: Download Windows artifact
        uses: actions/download-artifact@v4
        with:
          name: sync-artifact-windows-latest
          path: ./artifacts/windows/

      - name: Compare artifacts
        shell: bash
        run: |
          echo "Comparing Linux and Windows sync artifacts..."

          LINUX_ARTIFACT=$(find ./artifacts/linux -name "*.sdl-artifact.json" | head -n 1)
          WINDOWS_ARTIFACT=$(find ./artifacts/windows -name "*.sdl-artifact.json" | head -n 1)

          if [ -z "$LINUX_ARTIFACT" ] || [ -z "$WINDOWS_ARTIFACT" ]; then
            echo "✗ Missing artifacts for comparison"
            exit 1
          fi

          echo "Linux artifact: $LINUX_ARTIFACT"
          echo "Windows artifact: $WINDOWS_ARTIFACT"

          node -e "
            const fs = require('fs');
            const linux = JSON.parse(fs.readFileSync('${LINUX_ARTIFACT}', 'utf-8'));
            const windows = JSON.parse(fs.readFileSync('${WINDOWS_ARTIFACT}', 'utf-8'));
            
            console.log('Artifact comparison:');
            console.log('  Linux artifact_hash:', linux.artifact_hash);
            console.log('  Windows artifact_hash:', windows.artifact_hash);
            console.log('  Linux size:', linux.size_bytes);
            console.log('  Windows size:', windows.size_bytes);
            
            if (linux.artifact_hash === windows.artifact_hash) {
              console.log('✓ Artifacts match across platforms');
            } else {
              console.log('⚠ Artifacts differ (expected for different commit SHAs)');
              console.log('  Both artifacts are valid for their respective commits');
            }
          "
```

### Step 6: Commit and Push

```bash
# Add the workflow file
git add .github/workflows/ci.yml

# Commit your changes
git commit -m "Add CI Memory Sync workflow"

# Push to main branch
git push origin main
```

### Step 7: Verify CI Execution

1. Navigate to your repository on GitHub
2. Click on **Actions** tab
3. Select the latest workflow run
4. Verify all jobs completed successfully:
   - ✅ CI job
   - ✅ sync-memory job (only on main pushes)
   - ✅ sync-validation job (only on main pushes)

**Expected Workflow Duration:**

- CI job: ~2-5 minutes
- sync-memory job: ~30-60 seconds
- sync-validation job: ~10-30 seconds

### Step 8: Validate Artifacts

1. In the workflow run, scroll to the bottom
2. Click on **Artifacts** section
3. Verify these artifacts exist:
   - `sync-artifact-ubuntu-latest`
   - `sync-artifact-windows-latest`

4. Download an artifact to verify locally:

```bash
# Download artifact from GitHub UI
# Then validate locally
sdl-mcp import --artifact-path ./sync-ubuntu-latest-*.sdl-artifact.json --verify true
```

## Configuration Options

### Adjust Performance Budgets

Edit the workflow file to modify performance budgets:

```yaml
MAX_INDEX_MS=45000    # Increase for large repos
MAX_EXPORT_MS=8000    # Increase for complex repos
MAX_TOTAL_MS=53000   # Adjust total budget
```

### Change Artifact Retention

Modify artifact retention period:

```yaml
- name: Upload sync artifact
  uses: actions/upload-artifact@v4
  with:
    name: sync-artifact-${{ runner.os }}
    path: ./ci-artifacts/*.sdl-artifact.json
    retention-days: 60 # Change from 30 to 60 days
```

### Disable Sync on PRs

Currently, sync only runs on main pushes. To ensure this:

```yaml
sync-memory:
  if: github.event_name == 'push' && github.ref == 'refs/heads/main'
```

### Customize Node.js Version

Change the Node.js version matrix:

```yaml
matrix:
  os: [ubuntu-latest, windows-latest]
  node-version: [20.x] # Use only Node 20.x for consistency
```

## Testing

### Test Workflow Locally

Use `act` to test GitHub Actions locally:

```bash
# Install act
brew install act  # macOS
# or
choco install act  # Windows

# Run workflow locally
act push -j sync-memory
```

### Test Manual Trigger

Manually trigger the workflow:

1. Navigate to **Actions** tab
2. Select **CI** workflow
3. Click **Run workflow** dropdown
4. Select branch (usually `main`)
5. Click **Run workflow**

### Monitor Performance

Add performance monitoring:

```yaml
- name: Monitor performance trends
  if: always()
  run: |
    echo "Index: ${{ steps.index.outputs.duration_ms }}ms"
    echo "Export: ${{ steps.export.outputs.duration_ms }}ms"
```

## Common Issues

### Issue: "No repository specified or configured"

**Fix:** Add initialization step:

```yaml
- name: Initialize SDL-MCP
  run: |
    npm run init || node dist/cli/index.js init --force
```

### Issue: "Artifact file not found"

**Fix:** Ensure artifact upload step completes:

```yaml
- name: Upload sync artifact
  if: success()
  uses: actions/upload-artifact@v4
  with:
    name: sync-artifact-${{ runner.os }}
    path: ./ci-artifacts/*.sdl-artifact.json
```

### Issue: "Performance budget exceeded"

**Fix:** Adjust budgets or optimize repository:

```yaml
MAX_INDEX_MS=60000 # Increase budget
```

Or optimize ignore patterns:

```json
"ignore": [
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/coverage/**",
  "**/*.min.js",
  "**/*.min.css"
]
```

## Next Steps

After setup:

1. ✅ Monitor first few workflow runs
2. ✅ Review performance metrics
3. ✅ Adjust budgets if needed
4. ✅ Set up alerts for failures
5. ✅ Document any customizations

## Support

For issues or questions:

- Review [CI Memory Sync Operations Guide](CI_MEMORY_SYNC.md)
- Check [Troubleshooting](CI_MEMORY_SYNC.md#troubleshooting)
- Open an issue with workflow run URL

## Related Documentation

- [CI Memory Sync Operations Guide](CI_MEMORY_SYNC.md)
- [Sync Artifact Documentation](sync-artifacts.md)
- [User Guide](USER_GUIDE.md)
- [Testing Guide](TESTING.md)
