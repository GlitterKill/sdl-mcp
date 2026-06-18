# Semantic Enrichment Bridge

[Back to README](../README.md)

The semantic enrichment bridge keeps tree-sitter as SDL-MCP's base syntax layer and enriches graph precision from one provider per language. Provider priority is fixed:

1. SCIP
2. LSP

Only the selected source runs for a language. Lower-priority providers are reported as skipped with a reason so status output explains why a provider did not run.

## Relationship To `semantic`

`semantic` config still means embeddings, generated summaries, and hybrid retrieval. The bridge uses a separate `semanticEnrichment` section because SCIP and LSP change graph precision and provenance rather than vector search behavior.

## Current Behavior

- `sdl.semantic.enrichment.refresh` reports selected providers explicitly only when `semanticEnrichment.enabled` is true.
- `sdl.semantic.enrichment.status` reports source selection, skipped providers, last runs, and precision scores even when refresh is disabled.
- SCIP and LSP graph facts are materialized only by provider-first indexing. Refresh returns skipped-provider diagnostics that direct users to `sdl.index.refresh` with provider inputs enabled.
- Combined SCIP indexes are still valid provider-first inputs. Language-scoped refresh can report source selection, but it does not filter or ingest provider documents.
- `dryRun` and `force` remain accepted for compatibility but do not cause graph writes.

## Configuration

```json
{
  "semanticEnrichment": {
    "enabled": true,
    "autoRunOnIndexRefresh": false,
    "installPolicy": "never",
    "languages": ["typescript", "python"],
    "providers": {
      "scip": {
        "enabled": true,
        "indexes": []
      },
      "lsp": {
        "enabled": true,
        "confidence": 0.8,
        "candidateLimit": 200,
        "servers": {
          "typescript-language-server": {
            "serverId": "typescript-language-server",
            "command": "typescript-language-server",
            "args": ["--stdio"],
            "languages": ["typescript"],
            "documentLanguageIds": [
              "typescript",
              "typescriptreact",
              "javascript",
              "javascriptreact"
            ],
            "filePatterns": ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx"],
            "enabled": true
          },
          "pyright": {
            "serverId": "pyright",
            "command": "pyright-langserver",
            "args": ["--stdio"],
            "languages": ["python"],
            "documentLanguageIds": ["python"],
            "filePatterns": ["**/*.py", "**/*.pyi"],
            "capabilities": ["diagnostics"],
            "enabled": true
          }
        }
      }
    }
  }
}
```

When `providers.scip.indexes` is empty, the bridge reuses `scip.indexes`. `scip.generator` remains configured under `scip` and still gates verified `scip-io` generation.

`cacheDir` and `concurrency` are reserved compatibility knobs for future provider caches and cross-provider scheduling. Provider graph writes happen through provider-first indexing, not this bridge.

## Install Model

`installPolicy: "never"` refuses provider downloads. `installPolicy: "verified"` permits only checksum-verified downloads such as the existing `scip-io` path. SDL-MCP never runs package-manager install commands automatically.

LSP servers are externally owned. SDL-MCP accepts configured server entries with `serverId`, `command`, `args`, `languages`, `initializationOptions`, and `enabled`; separate installer apps can make those servers available and write or update this config.

For V2, configure TypeScript and JavaScript LSP enrichment with the SDL language ID `typescript`. The TypeScript adapter covers `.ts`, `.tsx`, `.js`, and `.jsx` files, so a separate `javascript` language entry is not used.

## LSIF Removed

LSIF support was removed because known LSIF-producing ecosystems also have SCIP indexers. Keeping LSIF would duplicate the lower-priority index path without expanding language coverage.

## Precision Score

Precision score combines:

- file coverage
- symbol match rate
- resolved edge rate
- provider tier
- diagnostics availability
- pass-2 skip coverage

SCIP has the highest provider tier and is the only source allowed to affect pass-2 scheduling. LSP stays as post-index enrichment until coverage can be measured per file and is comparable to SCIP.
