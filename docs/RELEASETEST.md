# SDL-MCP Release Testing Checklist

<div align="right">
<details>
<summary><strong>Docs Navigation</strong></summary>

- [Overview](../README.md)
- [Documentation Hub](./README.md)
  - [Getting Started](./getting-started.md)
  - [CLI Reference](./cli-reference.md)
  - [MCP Tools Reference](./mcp-tools-reference.md)
  - [Configuration Reference](./configuration-reference.md)
  - [Agent Workflows](./agent-workflows.md)
  - [Troubleshooting](./troubleshooting.md)
- [Legacy User Guide](./USER_GUIDE.md)

</details>
</div>

This document provides step-by-step testing for all SDL-MCP features before release.

## Prerequisites

```powershell
cd F:\Claude\projects\sdl-mcp\sdl-mcp

# Clean build
npm run build:all

# Clean database (fresh start)
Remove-Item .\\data\\sdlmcp.sqlite* -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force .\\.sdl-sync -ErrorAction SilentlyContinue
```

---

## Part 1: CLI Commands

### 1.1 Version Command

```powershell
node dist/cli/index.js version
```

**Expected:** Shows version number, Node.js version, platform, and arch.

- [ ] Version displays correctly
- [ ] No errors

### 1.2 Init Command

```powershell
# Remove existing config for clean test
Remove-Item config/sdlmcp.config.json -ErrorAction SilentlyContinue

node dist/cli/index.js init --repo-path . --client codex
```

**Expected:** Creates `config/sdlmcp.config.json` and client config template.

- [ ] Config file created
- [ ] Client template created (if specified)
- [ ] Shows next steps instructions

### 1.3 Doctor Command

```powershell
node dist/cli/index.js doctor
```

**Expected:** Runs environment checks and reports status.

- [ ] All checks pass (green checkmarks)
- [ ] No errors

### 1.4 Index Command

```powershell
node dist/cli/index.js index
```

**Expected:** Indexes the repository and shows statistics.

- [ ] Files processed count shown
- [ ] Symbols indexed count shown
- [ ] Edges created count shown
- [ ] Duration shown
- [ ] "Indexing complete" message

### 1.5 Serve Command (Manual Test)

```powershell
node dist/cli/index.js serve --stdio
```

**Expected:** Server starts and shows startup logs on stderr.

- [ ] "Loading configuration..." appears
- [ ] "Running database migrations..." appears
- [ ] "Registering MCP tools..." appears
- [ ] "SDL-MCP server running..." appears
- [ ] No stdout output (stdout reserved for JSON-RPC)
- [ ] Ctrl+C gracefully shuts down

---

## Part 2: MCP Tools (via Client)

Connect SDL-MCP to an MCP client (Codex, Claude Code, etc.) and test each tool.

### 2.1 Repository Management

#### sdl.repo.register

**Input:**
```json
{
  "repoId": "test-repo",
  "rootPath": "F:\\Claude\\projects\\sdl-mcp\\sdl-mcp",
  "languages": ["ts", "js"],
  "ignore": ["**/node_modules/**", "**/dist/**"]
}
```

**Expected:** Repository registered successfully.

- [ ] Returns success response
- [ ] No errors

#### sdl.repo.status

**Input:**
```json
{
  "repoId": "test-repo"
}
```

**Expected:** Returns repository status with file count, symbol count, last indexed time.

- [ ] Returns status object
- [ ] Shows indexed file count
- [ ] Shows symbol count

### 2.2 Indexing

#### sdl.index.refresh (Full)

**Input:**
```json
{
  "repoId": "test-repo",
  "mode": "full"
}
```

**Expected:** Full re-index of repository.

- [ ] Returns indexing stats
- [ ] filesProcessed > 0
- [ ] symbolsIndexed > 0
- [ ] edgesCreated > 0
- [ ] versionId returned

#### sdl.index.refresh (Incremental)

**Input:**
```json
{
  "repoId": "test-repo",
  "mode": "incremental"
}
```

**Expected:** Incremental index (only changed files).

- [ ] Returns indexing stats
- [ ] Completes faster than full index

### 2.3 Symbol Operations

#### sdl.symbol.search

**Input:**
```json
{
  "repoId": "test-repo",
  "query": "MCPServer",
  "limit": 10
}
```

**Expected:** Returns matching symbols.

- [ ] Returns results array
- [ ] Each result has symbolId, name, kind, file path
- [ ] Results match query

#### sdl.symbol.getCard

**Input:** (use symbolId from search results)
```json
{
  "repoId": "test-repo",
  "symbolId": "<symbolId-from-search>"
}
```

**Expected:** Returns full symbol card.

- [ ] Returns symbolId
- [ ] Returns name, kind, signature
- [ ] Returns file path and range
- [ ] Returns summary (if available)
- [ ] Returns edges (imports, calls)
- [ ] Returns metrics (fanIn, fanOut)
- [ ] Returns etag for caching

#### sdl.symbol.getCard (with ETag - Not Modified)

**Input:**
```json
{
  "repoId": "test-repo",
  "symbolId": "<symbolId>",
  "ifNoneMatch": "<etag-from-previous-call>"
}
```

**Expected:** Returns notModified: true if unchanged.

- [ ] Returns notModified: true
- [ ] Minimal response (no full card)

### 2.4 Graph Slicing

#### sdl.slice.build

**Input:**
```json
{
  "repoId": "test-repo",
  "taskText": "understand the MCP server implementation",
  "entrySymbols": ["<symbolId>"],
  "budget": { "maxCards": 20, "maxEstimatedTokens": 4000 }
}
```

**Expected:** Returns graph slice with related symbols.

- [ ] Returns sliceHandle (UUID)
- [ ] Returns cards array
- [ ] Returns ledgerVersion
- [ ] Returns lease with expiresAt
- [ ] Cards are sorted by relevance score

#### sdl.slice.refresh

**Input:**
```json
{
  "sliceHandle": "<handle-from-build>",
  "knownVersion": "<ledgerVersion-from-build>"
}
```

**Expected:** Returns delta or notModified.

- [ ] Returns notModified: true (if unchanged)
- [ ] Or returns delta with changed cards

#### sdl.slice.spillover.get

**Input:**
```json
{
  "spilloverHandle": "<spilloverHandle-from-build>",
  "pageSize": 20
}
```

**Expected:** Returns additional cards beyond initial slice.

- [ ] Returns cards array
- [ ] Returns a cursor or pagination token when more results exist

### 2.5 Delta Packs

#### sdl.delta.get

**Input:**
```json
{
  "repoId": "test-repo",
  "fromVersion": "<older-versionId>",
  "toVersion": "<newer-versionId>"
}
```

**Expected:** Returns changes between versions.

- [ ] Returns changedSymbols array
- [ ] Returns blastRadius (affected symbols)
- [ ] Each change shows what changed (signature, summary, etc.)

### 2.6 Code Access

#### sdl.code.getSkeleton

**Input:**
```json
{
  "repoId": "test-repo",
  "symbolId": "<symbolId>",
  "identifiersToFind": ["registerTool", "PolicyEngine"],
  "contextLines": 3
}
```

**Expected:** Returns deterministic code skeleton.

- [ ] Returns skeletonText (abbreviated code)
- [ ] Returns skeletonIR with ops and hash
- [ ] Skeleton is shorter than original code
- [ ] Control flow preserved (if/else, try/catch, loops)

#### sdl.code.getHotPath

**Input:**
```json
{
  "repoId": "test-repo",
  "symbolId": "<symbolId>"
}
```

**Expected:** Returns critical code paths.

- [ ] Returns hotPathText
- [ ] Returns range
- [ ] Returns estimatedTokens

#### sdl.code.needWindow

**Input:**
```json
{
  "repoId": "test-repo",
  "symbolId": "<symbolId>",
  "reason": "need to understand the implementation details",
  "expectedLines": 50,
  "identifiersToFind": ["handler", "tools"]
}
```

**Expected:** Returns code window or downgrade suggestion.

- [ ] Returns decision (approved/denied/downgrade)
- [ ] Returns auditHash
- [ ] If approved: returns code and range
- [ ] If denied: returns deniedReasons and nextBestAction
- [ ] If downgrade: suggests skeleton or hotpath

### 2.7 Policy Management

#### sdl.policy.get

**Input:**
```json
{
  "repoId": "test-repo"
}
```

**Expected:** Returns current policy settings.

- [ ] Returns policy object
- [ ] Shows maxWindowLines, maxWindowTokens
- [ ] Shows requireIdentifiers, allowBreakGlass

#### sdl.policy.set

**Input:**
```json
{
  "repoId": "test-repo",
  "policyPatch": {
    "maxWindowLines": 100,
    "requireIdentifiers": true
  }
}
```

**Expected:** Updates policy settings.

- [ ] Returns updated policy
- [ ] Changes persist

---

## Part 3: Integration Tests

### 3.1 End-to-End Workflow

1. Register repo
2. Full index
3. Search for symbol
4. Get symbol card
5. Build slice from symbol
6. Get skeleton for symbol in slice
7. Request code window
8. Get delta between versions

- [ ] All steps complete without errors
- [ ] Data flows correctly between steps

### 3.2 Determinism Test

Run getSkeleton 3 times for the same symbol:

- [ ] All 3 responses have identical skeletonText
- [ ] All 3 responses have identical skeletonIR.hash

### 3.3 Caching Test

1. Get symbol card (note etag)
2. Get symbol card with ifNoneMatch = etag
3. Verify notModified: true

- [ ] ETag caching works correctly

### 3.4 Lease Expiry Test

1. Build slice (note lease.expiresAt)
2. Verify expiresAt is in the future
3. Verify sliceHandle works before expiry

- [ ] Lease timestamps are valid

---

## Part 4: Error Handling

### 4.1 Invalid Repo ID

```json
{
  "repoId": "nonexistent-repo"
}
```

- [ ] Returns appropriate error message
- [ ] Does not crash server

### 4.2 Invalid Symbol ID

```json
{
  "symbolId": "nonexistent-symbol"
}
```

- [ ] Returns appropriate error message
- [ ] Does not crash server

### 4.3 Invalid Slice Handle

```json
{
  "sliceHandle": "invalid-handle"
}
```

- [ ] Returns appropriate error message
- [ ] Does not crash server

### 4.4 Malformed Input

```json
{
  "repoId": 12345
}
```

- [ ] Returns validation error
- [ ] Does not crash server

---

## Part 5: Performance Checks

### 5.1 Large File Handling

- [ ] Files over 100KB index without timeout
- [ ] Memory usage stays reasonable

### 5.2 Response Times

- [ ] symbol.search < 500ms
- [ ] symbol.getCard < 200ms
- [ ] slice.build < 2s
- [ ] code.getSkeleton < 500ms

### 5.3 Concurrent Requests

- [ ] Multiple simultaneous requests handled correctly
- [ ] No race conditions or deadlocks

---

## Part 6: Client Compatibility

Test with each supported client:

### 6.1 Codex CLI

- [ ] Server connects successfully
- [ ] Tools appear in tool list
- [ ] Tool calls work correctly

### 6.2 Claude Code

- [ ] Server connects successfully
- [ ] Tools appear in tool list
- [ ] Tool calls work correctly

### 6.3 Gemini CLI

- [ ] Server connects successfully
- [ ] Tools appear in tool list
- [ ] Tool calls work correctly

---

## Sign-Off

| Test Section | Pass | Fail | Notes |
|--------------|------|------|-------|
| CLI Commands | | | |
| Repository Management | | | |
| Indexing | | | |
| Symbol Operations | | | |
| Graph Slicing | | | |
| Delta Packs | | | |
| Code Access | | | |
| Policy Management | | | |
| Integration Tests | | | |
| Error Handling | | | |
| Performance | | | |
| Client Compatibility | | | |

**Tested By:** _______________
**Date:** _______________
**Version:** 0.6.0
**Result:** PASS / FAIL
