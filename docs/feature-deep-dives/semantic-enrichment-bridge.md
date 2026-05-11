# Semantic Enrichment Bridge

[Back to README](../README.md)

The semantic enrichment bridge keeps tree-sitter as SDL-MCP's base syntax layer and enriches graph precision from one provider per language. Provider priority is fixed:

1. SCIP
2. LSP

Only the selected source runs for a language. Lower-priority providers are reported as skipped with a reason so status output explains why a provider did not run.

## Relationship To `semantic`

`semantic` config still means embeddings, generated summaries, and hybrid retrieval. The bridge uses a separate `semanticEnrichment` section because SCIP and LSP change graph precision and provenance rather than vector search behavior.

## Current Behavior

- `sdl.semantic.enrichment.refresh` runs selected providers explicitly only when `semanticEnrichment.enabled` is true.
- `sdl.semantic.enrichment.status` reports source selection, skipped providers, last runs, and precision scores even when refresh is disabled.
- SCIP remains compatible with `sdl.scip.ingest` and keeps its existing optimized index-refresh placement: pass-1 drain, SCIP ingest, then pass 2.
- LSP uses a lightweight stdio JSON-RPC client. TypeScript/JavaScript LSP enrichment queries call-definition candidates derived from tree-sitter call ranges and can replace unresolved or heuristic call edges with exact provider-backed edges.
- LSP remains post-index only. It does not resolve imports/references, execute package-manager install recipes, or affect pass-2 scheduling.
- Combined SCIP indexes are supported. Language-scoped refresh filters provider documents to the requested language set instead of requiring one index file per language.
- `force` bypasses compatible cache decisions where they exist. In V2, that means the SCIP ingestion content-hash shortcut; LSP has no durable response cache yet.

## Configuration

```json
{
  "semanticEnrichment": {
    "enabled": true,
    "autoRunOnIndexRefresh": false,
    "installPolicy": "never",
    "languages": ["typescript"],
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
          "typescript": {
            "serverId": "typescript",
            "command": "typescript-language-server",
            "args": ["--stdio"],
            "languages": ["typescript"],
            "initializationOptions": {},
            "enabled": true
          }
        }
      }
    }
  }
}
```

When `providers.scip.indexes` is empty, the bridge reuses `scip.indexes`. `scip.generator` remains configured under `scip` and still gates verified `scip-io` generation.

`cacheDir` and `concurrency` are reserved compatibility knobs for future provider caches and cross-provider scheduling. V2 runs selected providers serially and writes provider results directly to the graph.

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
