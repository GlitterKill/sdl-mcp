# sdl.symbol.edit

`sdl.symbol.edit` provides symbol-scoped editing without replacing the safer file write machinery. Preview computes the exact post-edit content, stores the plan in the existing search-edit plan store, and apply enforces symbol, file, and draft preconditions before writing.

Use `symbol.edit` when the intended edit is anchored to one symbol and the caller already has a symbol card, symbol ID, or precise `symbolRef`. Use `search.edit` for cross-file pattern changes, and use `file.write` for immediate single-file edits that are not symbol-shaped.

## Modes

| Mode | Use when | Required fields |
| ---- | -------- | --------------- |
| `preview` | You want a plan handle before changing anything. | `repoId`, `operation`, and exactly one of `symbolId` or `symbolRef` |
| `apply` | You reviewed a preview and want to apply it. | `repoId`, `planHandle` |
| `applyNow` | You want one-call edit+apply with strict caller-supplied freshness checks. | `repoId`, `symbolId`, `operation`, `expectedAstFingerprint`, `expectedRange` |

`applyNow` is intentionally stricter than `preview`. It requires the exact symbol snapshot that the caller believes is current, so stale cards fail before any write plan is created.

## Operations

| Operation | Description | TypeScript/JavaScript family support | Other indexed languages |
| --------- | ----------- | ---------------------- | ----------------------- |
| `replaceSymbol` | Replace the full symbol range. | Yes | Yes, when indexed symbol ranges are available |
| `replaceBody` | Replace only the inner body content and preserve delimiters. | Yes | No |
| `replaceSignature` | Replace the declaration header and preserve the body. | Yes | No |
| `insertBefore` | Insert sibling text immediately before the symbol declaration. | Yes | Yes, when indexed symbol ranges are available |
| `insertAfter` | Insert sibling text immediately after the symbol declaration. | Yes | Yes, when indexed symbol ranges are available |
| `renameLocal` | Rename a declaration, parameter, or local identifier inside the selected symbol only. | Yes | No |

V1 does not run a formatter or auto-indent replacement text. SDL-MCP inserts the supplied text exactly, except for newline-boundary normalization around adjacent inserts and body delimiters.

Unsupported shapes fail closed. For example, ambient declarations and overload-only TypeScript declarations reject `replaceBody` because there is no body range to edit.

## Preconditions

Preview stores:

- `symbolId`, `astFingerprint`, and symbol range
- resolved file path, saved-file sha256, and saved-file mtime
- draft version and draft content sha when the preview is planned against a live overlay

Apply rejects stale symbols, stale files, and stale drafts. The caller must re-run preview after a rejection.

## Validation

For TypeScript, TSX, JavaScript, and JSX, preview uses the TypeScript-family Tree-sitter parser before and after the edit. For other indexed languages, V1 permits only whole-symbol and adjacent insert operations when the language adapter can parse before and after the edit. A parse-after failure rejects the plan before any file or draft update. Apply rechecks the symbol snapshot and file or draft preconditions before writing.

If a saved-file write succeeds but graph or live-index sync fails, SDL-MCP keeps the file write and returns the existing `indexUpdate.applied = false` guidance instead of rolling the file back.

## Draft Behavior

When a live draft exists for the target file, preview plans against the draft content. Applying that plan updates the live overlay through the buffer pipeline and does not write the saved file.

The CLI command `sdl-mcp tool symbol.edit` operates on saved files. Use `applyNow` for CLI writes because preview plan handles live in the current process. Two-phase `preview`/`apply` and overlay-aware draft edits require the MCP server session that owns the plan or live draft.

## Examples

Preview a body replacement:

```json
{
  "repoId": "my-repo",
  "mode": "preview",
  "symbolRef": { "name": "handleAuth", "file": "src/auth.ts" },
  "operation": { "kind": "replaceBody", "content": "return true;\n" }
}
```

Apply the preview:

```json
{
  "repoId": "my-repo",
  "mode": "apply",
  "planHandle": "se-mf0abc-1234"
}
```

Apply immediately with an exact snapshot:

```json
{
  "repoId": "my-repo",
  "mode": "applyNow",
  "symbolId": "<symbol-id>",
  "expectedAstFingerprint": "<ast-fingerprint-from-card>",
  "expectedRange": { "startLine": 12, "startCol": 0, "endLine": 18, "endCol": 1 },
  "operation": {
    "kind": "replaceSignature",
    "content": "export async function handleAuth(user: User): Promise<boolean>"
  }
}
```

In Code Mode, use the `sdl.file` wrapper operations:

```json
{
  "op": "symbolEditPreview",
  "repoId": "my-repo",
  "symbolId": "<symbol-id>",
  "operation": { "kind": "insertAfter", "content": "export const next = 1;\n" }
}
```

Then apply with:

```json
{
  "op": "symbolEditApply",
  "repoId": "my-repo",
  "planHandle": "se-mf0abc-1234"
}
```
