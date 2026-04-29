# Architecture: Tech Stack & Data Flow

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
- [Iris Gate Ladder](./feature-deep-dives/iris-gate-ladder.md)
- [Architecture (this page)](./architecture.md)

</details>
</div>

SDL-MCP is a high-performance codebase indexing and context retrieval server. This document describes the system architecture, data flow, and key design patterns.

---

## Technical Stack

| Layer        | Technology                                                                                                                                                                                                                 |
| :----------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime      | Node.js v24+ / TypeScript 5.9+ (strict, ESM)                                                                                                                                                                               |
| Database     | LadybugDB (embedded graph database, single-file storage, Kuzu engine)                                                                                                                                                      |
| MCP SDK      | `@modelcontextprotocol/sdk` ^1.27.1                                                                                                                                                                                        |
| Transports   | stdio (CLI agents), HTTP/SSE (network clients)                                                                                                                                                                             |
| AST parsing  | tree-sitter 0.26.2 (via @keqingmoe/tree-sitter) + language grammars via `sdl-mcp-tree-sitter-*` wrapper packages (peer-range normalized to accept 0.26.x; see [grammar-wrappers/README.md](../grammar-wrappers/README.md)) |
| Native addon | Rust via napi-rs (optional, multi-threaded pass-1)                                                                                                                                                                         |
| Embeddings   | ONNX Runtime (jina-embeddings-v2-base-code 768-dim bundled, nomic-embed-text-v1.5 768-dim optional)                                                                                                                        |
| Validation   | Zod schemas for all tool payloads and responses                                                                                                                                                                            |

---

## Architectural Pattern

SDL-MCP follows a **hexagonal / ports-and-adapters** design. Each module has a clear role and no cross-layer mutations:

```mermaid
%%{init: {"theme":"base","themeVariables":{"background":"#ffffff","primaryColor":"#E7F8F2","primaryBorderColor":"#0F766E","primaryTextColor":"#102A43","secondaryColor":"#E8F1FF","secondaryBorderColor":"#2563EB","secondaryTextColor":"#102A43","tertiaryColor":"#FFF4D6","tertiaryBorderColor":"#B45309","tertiaryTextColor":"#102A43","lineColor":"#0F766E","textColor":"#102A43","fontFamily":"Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"},"flowchart":{"curve":"basis","htmlLabels":true}}}%%
flowchart TD
    Tools["MCP tool layer<br/>tools.ts, server.ts, coord.ts"]
    Indexer["Indexer<br/>write path<br/>pass-1 + pass-2<br/>clusters, processes, summaries"]
    Graph["Graph<br/>read path<br/>slice build, beam search, spillover, card cache"]
    Code["Code<br/>read path<br/>skeleton, hot-path, windows, gate/policy"]
    DB["LadybugDB<br/>Symbols, edges, files, repos, versions, embeddings, summaries, memories<br/>FTS + vector indexes"]

    Tools e1@--> Indexer
    Tools e2@--> Graph
    Tools e3@--> Code
    Indexer e4@--> DB
    Graph e5@--> DB
    Code e6@--> DB

    classDef source fill:#E7F8F2,stroke:#0F766E,stroke-width:2px,color:#102A43;
    classDef process fill:#E8F1FF,stroke:#2563EB,stroke-width:2px,color:#102A43;
    classDef decision fill:#FFF4D6,stroke:#B45309,stroke-width:2px,color:#102A43;
    classDef storage fill:#F2E8FF,stroke:#7C3AED,stroke-width:2px,color:#102A43;
    classDef output fill:#FFE8EF,stroke:#BE123C,stroke-width:2px,color:#102A43;
    classDef muted fill:#F8FAFC,stroke:#64748B,stroke-width:1px,color:#102A43;
    classDef animate stroke:#0F766E,stroke-width:2px,stroke-dasharray:10\,5,stroke-dashoffset:900,animation:dash 22s linear infinite;
    class e1,e2,e3,e4,e5,e6 animate;
```

- **Indexer** produces pure domain objects (symbols, edges) — owns all writes
- **Graph** reads from DB to build slices — no mutations
- **Retrieval** (`src/retrieval/`) orchestrates hybrid search (FTS + vector + RRF fusion), with automatic fallback to legacy. Provides the start-node discovery engine for `slice.build` and `symbol.search`.
- **Delta** reads version pairs, computes diffs on demand — no mutations
- **Code** reads file content and applies policy gating — no mutations
- **DB** owns all persistence (queries + mutations separated by module)

---

## Startup Sequence

`src/main.ts` initializes the system in a strict order:

```
1. loadConfig()                         Config + Zod validation
2. initGraphDb()                        Open/create LadybugDB file
3. ensureConfiguredReposRegistered()     Bootstrap repos into graph
4. getDefaultLiveIndexCoordinator()      Singleton overlay service
5. registerTools(server, services)       Wire discovery/info tools plus flat, gateway, and/or code-mode tools
6. setupFileWatchers()                   chokidar for incremental re-index
7. ShutdownManager.register(callbacks)   Graceful cleanup handlers
8. server.start()                        Begin accepting MCP requests
```

Startup is sequenced (not parallel) — the DB must be ready before tools register, and tools must be registered before the transport accepts connections.

---

## Tool Dispatch

All MCP tools flow through a single dispatch path in `src/server.ts`. The exact surface is configuration-dependent:

- Flat mode: 33 tools (`31` flat tools + `sdl.action.search` + `sdl.info`)
- Gateway-only mode: 6 tools (`4` gateway tools + `sdl.action.search` + `sdl.info`)
- Gateway + legacy mode: 37 tools (`4` gateway tools + `31` legacy flat tools + `sdl.action.search` + `sdl.info`)
- Code Mode adds `sdl.manual`, `sdl.context`, `sdl.workflow`, and `sdl.file`, or can run in exclusive mode with just `sdl.action.search`, `sdl.manual`, `sdl.context`, `sdl.workflow`, and `sdl.file`

Before strict Zod validation, requests also pass through a shared normalization layer. Flat and gateway calls therefore accept the same canonical camelCase fields plus common aliases such as `repo_id`, `root_path`, `symbol_id`, `symbol_ids`, `from_version`, `to_version`, `slice_handle`, and `spillover_handle`.

```mermaid
%%{init: {"theme":"base","themeVariables":{"background":"#ffffff","primaryColor":"#E7F8F2","primaryBorderColor":"#0F766E","primaryTextColor":"#102A43","secondaryColor":"#E8F1FF","secondaryBorderColor":"#2563EB","secondaryTextColor":"#102A43","tertiaryColor":"#FFF4D6","tertiaryBorderColor":"#B45309","tertiaryTextColor":"#102A43","lineColor":"#0F766E","textColor":"#102A43","fontFamily":"Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"},"flowchart":{"curve":"basis","htmlLabels":true}}}%%
flowchart TD
    Request["Client request"]
    Validate["Zod schema validation"]
    Error["Validation error<br/>return isError response"]
    Limit["Dispatch limiter<br/>max 8 concurrent handlers<br/>30s queue timeout"]
    Handler["Tool handler<br/>returns result + optional _rawContext"]
    Post["Post-process pipeline<br/>compute _tokenUsage<br/>strip _rawContext<br/>logToolCall telemetry"]
    Response["JSON response wrapped in MCP content format"]

    Request e1@--> Validate
    Validate e2@-->|ok| Limit
    Limit e4@--> Handler
    Handler e5@--> Post
    Post e6@--> Response
    Validate e3@-->|error| Error

    classDef source fill:#E7F8F2,stroke:#0F766E,stroke-width:2px,color:#102A43;
    classDef process fill:#E8F1FF,stroke:#2563EB,stroke-width:2px,color:#102A43;
    classDef decision fill:#FFF4D6,stroke:#B45309,stroke-width:2px,color:#102A43;
    classDef storage fill:#F2E8FF,stroke:#7C3AED,stroke-width:2px,color:#102A43;
    classDef output fill:#FFE8EF,stroke:#BE123C,stroke-width:2px,color:#102A43;
    classDef muted fill:#F8FAFC,stroke:#64748B,stroke-width:1px,color:#102A43;
    classDef animate stroke:#0F766E,stroke-width:2px,stroke-dasharray:10\,5,stroke-dashoffset:900,animation:dash 22s linear infinite;
    class e1,e2,e3,e4,e5,e6 animate;
```

**Sideband system:** Handlers can attach `_rawContext` hints (file IDs or raw token counts). The post-processor computes `_tokenUsage` metadata (SDL tokens vs. raw-file equivalent, savings percentage) and strips internal fields before serialization.

`tools/list` metadata is assembled here as well. SDL-MCP emits human-friendly tool titles and version-stamped descriptions so flat, gateway, and code-mode registrations present a consistent surface to clients.

---

## Indexing Pipeline

Indexing happens in two passes plus a finalization stage. Triggered by `sdl-mcp index` (CLI) or `sdl.index.refresh` (MCP tool).

### Pass 1: Local Extraction

Per-file, parallelizable. Each file produces:

```mermaid
%%{init: {"theme":"base","themeVariables":{"background":"#ffffff","primaryColor":"#E7F8F2","primaryBorderColor":"#0F766E","primaryTextColor":"#102A43","secondaryColor":"#E8F1FF","secondaryBorderColor":"#2563EB","secondaryTextColor":"#102A43","tertiaryColor":"#FFF4D6","tertiaryBorderColor":"#B45309","tertiaryTextColor":"#102A43","lineColor":"#0F766E","textColor":"#102A43","fontFamily":"Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"},"flowchart":{"curve":"basis","htmlLabels":true}}}%%
flowchart TD
    Source["Source file<br/>.ts, .py, .go, ..."] e1@--> Engine["Indexer engine<br/>Rust native or Tree-sitter fallback"]
    Engine e2@--> Symbols["Symbols<br/>name, kind, range, signature"]
    Engine e3@--> Imports["Imports<br/>module, alias, source"]
    Engine e4@--> Calls["Calls<br/>raw identifiers"]
    Engine e5@--> Fingerprints["Fingerprints<br/>SHA-256 of symbol parts"]

    classDef source fill:#E7F8F2,stroke:#0F766E,stroke-width:2px,color:#102A43;
    classDef process fill:#E8F1FF,stroke:#2563EB,stroke-width:2px,color:#102A43;
    classDef decision fill:#FFF4D6,stroke:#B45309,stroke-width:2px,color:#102A43;
    classDef storage fill:#F2E8FF,stroke:#7C3AED,stroke-width:2px,color:#102A43;
    classDef output fill:#FFE8EF,stroke:#BE123C,stroke-width:2px,color:#102A43;
    classDef muted fill:#F8FAFC,stroke:#64748B,stroke-width:1px,color:#102A43;
    classDef animate stroke:#0F766E,stroke-width:2px,stroke-dasharray:10\,5,stroke-dashoffset:900,animation:dash 22s linear infinite;
    class e1,e2,e3,e4,e5 animate;
```

**Language adapters** (`src/indexer/adapter/`) — 11 adapters covering 12 languages, each extends `BaseAdapter`:

- `typescript.ts` (shared by TS/JS), `python.ts`, `go.ts`, `java.ts`, `rust.ts`, `csharp.ts`, `c.ts`, `cpp.ts`, `php.ts`, `kotlin.ts`, `shell.ts`

**Native Rust engine** (`native/src/extract/`) — optional, mirrors all TS adapters at near-native speed via napi-rs.

### Pass 2: Cross-File Resolution

Sequential, cross-file. Resolves raw call identifiers to specific symbol IDs using the pass-2 resolver registry (`src/indexer/pass2/registry.ts`):

```mermaid
%%{init: {"theme":"base","themeVariables":{"background":"#ffffff","primaryColor":"#E7F8F2","primaryBorderColor":"#0F766E","primaryTextColor":"#102A43","secondaryColor":"#E8F1FF","secondaryBorderColor":"#2563EB","secondaryTextColor":"#102A43","tertiaryColor":"#FFF4D6","tertiaryBorderColor":"#B45309","tertiaryTextColor":"#102A43","lineColor":"#0F766E","textColor":"#102A43","fontFamily":"Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"},"flowchart":{"curve":"basis","htmlLabels":true}}}%%
flowchart TD
    Raw["Raw call edge<br/>getUserById"] e1@--> Registry["Resolver registry<br/>11 language-specific resolvers<br/>selected by file extension"]
    Registry e2@--> Resolver["Language resolver<br/>import maps, alias chains, barrel re-exports,<br/>package resolution, inheritance"]
    Resolver e3@--> Resolved["Resolved edge<br/>targetSymbolId: abc123<br/>confidence: 0.92<br/>strategy: import-alias"]

    classDef source fill:#E7F8F2,stroke:#0F766E,stroke-width:2px,color:#102A43;
    classDef process fill:#E8F1FF,stroke:#2563EB,stroke-width:2px,color:#102A43;
    classDef decision fill:#FFF4D6,stroke:#B45309,stroke-width:2px,color:#102A43;
    classDef storage fill:#F2E8FF,stroke:#7C3AED,stroke-width:2px,color:#102A43;
    classDef output fill:#FFE8EF,stroke:#BE123C,stroke-width:2px,color:#102A43;
    classDef muted fill:#F8FAFC,stroke:#64748B,stroke-width:1px,color:#102A43;
    classDef animate stroke:#0F766E,stroke-width:2px,stroke-dasharray:10\,5,stroke-dashoffset:900,animation:dash 22s linear infinite;
    class e1,e2,e3 animate;
```

11 language-specific resolvers are registered, all performing semantic cross-file analysis. Every resolver builds a repo-wide index (namespace, module, package, or directory-scoped), follows import/use/include/source chains to resolve call targets, handles language-specific patterns (generics, traits, templates, extensions, header pairs), and assigns stratified confidence scores (same-file 0.93 → imports 0.9 → same-scope 0.88–0.92 → fallback 0.45–0.78). TS and JS share one resolver implementation; the remaining 10 languages each have a dedicated resolver (700–1,350 lines).

### Finalization

After pass 1 + 2:

1. **Cluster detection** — Label Propagation Algorithm (Rust addon or TS fallback) groups highly-coupled symbols
2. **Process tracing** — call-chain analysis identifies entry/intermediate/exit roles
3. **Embedding generation** — ONNX models produce vector embeddings for semantic search
4. **LLM summaries** — optional, generates 1-3 sentence descriptions per symbol via API (Anthropic, Ollama, or mock)
5. **Version bump** — new ledger version recorded in graph

---

## Database Architecture

### LadybugDB (Embedded Graph Database)

SDL-MCP uses LadybugDB (Kuzu engine, npm alias `kuzu`) as the sole persistence layer. The database is a single file on disk (`.lbug` extension).

**Path resolution** (`src/db/initGraphDb.ts`):

1. `SDL_GRAPH_DB_PATH` env var (or legacy `SDL_DB_PATH`)
2. `graphDatabase.path` in config
3. Default: `<configDir>/sdl-mcp-graph.lbug`

**Schema** (`src/db/ladybug-schema.ts`) — idempotent DDL runs on startup. No migration files needed.

**Connection pool:**

```mermaid
%%{init: {"theme":"base","themeVariables":{"background":"#ffffff","primaryColor":"#E7F8F2","primaryBorderColor":"#0F766E","primaryTextColor":"#102A43","secondaryColor":"#E8F1FF","secondaryBorderColor":"#2563EB","secondaryTextColor":"#102A43","tertiaryColor":"#FFF4D6","tertiaryBorderColor":"#B45309","tertiaryTextColor":"#102A43","lineColor":"#0F766E","textColor":"#102A43","fontFamily":"Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"},"flowchart":{"curve":"basis","htmlLabels":true}}}%%
flowchart TD
    Reads["Read pool<br/>round-robin connections<br/>default 4, configurable 1-8"]
    Limit["ConcurrencyLimiter(1)"] e1@--> Write["Serialized write connection<br/>withWriteConn(async fn)"]
    Reads e2@--> DB["LadybugDB"]
    Write e3@--> DB

    classDef source fill:#E7F8F2,stroke:#0F766E,stroke-width:2px,color:#102A43;
    classDef process fill:#E8F1FF,stroke:#2563EB,stroke-width:2px,color:#102A43;
    classDef decision fill:#FFF4D6,stroke:#B45309,stroke-width:2px,color:#102A43;
    classDef storage fill:#F2E8FF,stroke:#7C3AED,stroke-width:2px,color:#102A43;
    classDef output fill:#FFE8EF,stroke:#BE123C,stroke-width:2px,color:#102A43;
    classDef muted fill:#F8FAFC,stroke:#64748B,stroke-width:1px,color:#102A43;
    classDef animate stroke:#0F766E,stroke-width:2px,stroke-dasharray:10\,5,stroke-dashoffset:900,animation:dash 22s linear infinite;
    class e1,e2,e3 animate;
```

Read pool enables concurrent multi-session reads (4-6 MCP sessions). Write serialization prevents graph corruption.

### Graph Schema (22 Node Tables, 14 Edge Tables)

**Core nodes:**

| Node Table        | Key Fields                                                                                                                                                        |
| :---------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Repo**          | repoId, rootPath, configJson, createdAt                                                                                                                           |
| **File**          | fileId, repoId, relPath, byteSize, contentHash                                                                                                                    |
| **Symbol**        | symbolId, repoId, fileId, kind, name, exported, signatureJson, summary, summaryQuality, summarySource, etag, embeddingJinaCode, embeddingNomic, embeddingJinaCode |
| **Version**       | versionId, repoId, timestamp, indexedAt                                                                                                                           |
| **SymbolVersion** | symbolId, versionId, signatureJson, summary                                                                                                                       |
| **Metrics**       | symbolId, repoId, fanIn, fanOut, churn, testRefs                                                                                                                  |

**Graph enrichment nodes:**

| Node Table      | Key Fields                                                                                |
| :-------------- | :---------------------------------------------------------------------------------------- |
| **Cluster**     | clusterId, label, memberCount, searchText                                                 |
| **Process**     | processId, label, repoId, searchText                                                      |
| **FileSummary** | fileId, repoId, summary, searchText, embeddingJinaCode, embeddingNomic, embeddingJinaCode |

**Infrastructure nodes:**

| Node Table        | Key Fields                                                                                               |
| :---------------- | :------------------------------------------------------------------------------------------------------- |
| **SliceHandle**   | handle, createdAt, expiresAt, minVersion, maxVersion                                                     |
| **CardHash**      | symbolId, hash                                                                                           |
| **Audit**         | auditId, repoId, action, timestamp                                                                       |
| **AgentFeedback** | feedbackId, repoId, taskText, taskType, searchText, embeddingJinaCode, embeddingNomic, embeddingJinaCode |
| **SchemaVersion** | version, appliedAt                                                                                       |

**Semantic nodes:**

| Node Table          | Key Fields                                            |
| :------------------ | :---------------------------------------------------- |
| **SymbolEmbedding** | symbolId, embedding, model                            |
| **SummaryCache**    | symbolId, summary, provider, model, cardHash, costUsd |
| **SymbolReference** | referenceId, symbolId, file, line                     |

**Sync, policy, and memory nodes:**

| Node Table         | Key Fields                                                |
| :----------------- | :-------------------------------------------------------- |
| **SyncArtifact**   | artifactId, repoId, format, createdAt                     |
| **ToolPolicyHash** | toolName, hash                                            |
| **TsconfigHash**   | repoId, hash                                              |
| **Memory**         | memoryId, repoId, type, title, content, tags, createdAt   |
| **UsageSnapshot**  | snapshotId, sessionId, totalSdlTokens, totalRawEquivalent |

**Edge tables (14):**

| Edge Table               | From → To          | Key Fields                                         |
| :----------------------- | :----------------- | :------------------------------------------------- |
| **FILE_IN_REPO**         | File → Repo        | —                                                  |
| **SYMBOL_IN_FILE**       | Symbol → File      | —                                                  |
| **SYMBOL_IN_REPO**       | Symbol → Repo      | —                                                  |
| **DEPENDS_ON**           | Symbol → Symbol    | edgeKind, confidence, resolverStrategy, provenance |
| **VERSION_OF_REPO**      | Version → Repo     | —                                                  |
| **BELONGS_TO_CLUSTER**   | Symbol → Cluster   | membershipScore                                    |
| **PARTICIPATES_IN**      | Symbol → Process   | stepOrder, role                                    |
| **CLUSTER_IN_REPO**      | Cluster → Repo     | —                                                  |
| **PROCESS_IN_REPO**      | Process → Repo     | —                                                  |
| **HAS_MEMORY**           | Repo → Memory      | —                                                  |
| **MEMORY_OF**            | Memory → Symbol    | —                                                  |
| **MEMORY_OF_FILE**       | Memory → File      | —                                                  |
| **FILE_SUMMARY_IN_REPO** | FileSummary → Repo | —                                                  |
| **SUMMARY_OF_FILE**      | FileSummary → File | —                                                  |

### Query Modules

Each module owns a specific domain of queries:

| Module                         | Purpose                                                                             |
| :----------------------------- | :---------------------------------------------------------------------------------- |
| `ladybug-repos.ts`             | Repo CRUD, registration, config                                                     |
| `ladybug-symbols.ts`           | Symbol upsert, search, ETag, batch fetch                                            |
| `ladybug-edges.ts`             | Call/import edge mutations, confidence updates                                      |
| `ladybug-versions.ts`          | Version chain, timestamp tracking                                                   |
| `ladybug-clusters.ts`          | Cluster membership, label queries                                                   |
| `ladybug-processes.ts`         | Process steps, role queries                                                         |
| `ladybug-embeddings.ts`        | **Deprecated** — legacy SymbolEmbedding node queries                                |
| `ladybug-symbol-embeddings.ts` | Inline embedding properties on Symbol nodes (replacement for ladybug-embeddings.ts) |
| `ladybug-metrics.ts`           | Fan-in/out, churn, test refs                                                        |
| `ladybug-feedback.ts`          | Agent feedback, audit events, searchText + embeddings for retrieval boosting        |
| `ladybug-slices.ts`            | Slice handles, lease expiry                                                         |
| `ladybug-memories.ts`          | Memory nodes, symbol/file links, staleness                                          |
| `ladybug-file-summaries.ts`    | FileSummary nodes — file-level summaries with searchText and embeddings             |
| `ladybug-usage.ts`             | Token usage tracking, savings metrics                                               |

---

## Graph Slicing

The slice builder (`src/graph/slice.ts`) constructs task-scoped context subgraphs bounded by a token budget.

```mermaid
%%{init: {"theme":"base","themeVariables":{"background":"#ffffff","primaryColor":"#E7F8F2","primaryBorderColor":"#0F766E","primaryTextColor":"#102A43","secondaryColor":"#E8F1FF","secondaryBorderColor":"#2563EB","secondaryTextColor":"#102A43","tertiaryColor":"#FFF4D6","tertiaryBorderColor":"#B45309","tertiaryTextColor":"#102A43","lineColor":"#0F766E","textColor":"#102A43","fontFamily":"Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"},"flowchart":{"curve":"basis","htmlLabels":true}}}%%
flowchart TD
    Entry["Entry symbols<br/>explicit IDs or auto-discovered from taskText"] e1@--> Start["Start-node resolver<br/>explicit IDs, hybrid retrieval, stack traces,<br/>edited files, legacy search"]
    Start e2@--> Beam["Beam-search engine<br/>weighted BFS<br/>call 1.0, config 0.8, import 0.6<br/>adaptive minConfidence + budget tracking"]
    Beam e3@--> Serialize["Slice serializer<br/>adaptive detail<br/>in-slice edge filtering<br/>ETag dedup + spillover"]

    classDef source fill:#E7F8F2,stroke:#0F766E,stroke-width:2px,color:#102A43;
    classDef process fill:#E8F1FF,stroke:#2563EB,stroke-width:2px,color:#102A43;
    classDef decision fill:#FFF4D6,stroke:#B45309,stroke-width:2px,color:#102A43;
    classDef storage fill:#F2E8FF,stroke:#7C3AED,stroke-width:2px,color:#102A43;
    classDef output fill:#FFE8EF,stroke:#BE123C,stroke-width:2px,color:#102A43;
    classDef muted fill:#F8FAFC,stroke:#64748B,stroke-width:1px,color:#102A43;
    classDef animate stroke:#0F766E,stroke-width:2px,stroke-dasharray:10\,5,stroke-dashoffset:900,animation:dash 22s linear infinite;
    class e1,e2,e3 animate;
```

**Card detail levels** — the serializer adapts detail based on remaining budget:

| Level     | Fields Included                                    | ~Tokens |
| :-------- | :------------------------------------------------- | :------ |
| minimal   | name, kind, range                                  | ~15     |
| signature | + signature, summary (truncated)                   | ~40     |
| deps      | + dependencies (filtered to slice)                 | ~80     |
| full      | everything (invariants, metrics, cluster, process) | ~135    |

**Wire format versions:** V1 (compact field names), V2 (deduplicated lookup tables), V3 (grouped edge encoding for large slices).

---

## Context Ladder (Iris Gate)

The four-rung escalation ladder controls how much raw code an agent receives:

```mermaid
%%{init: {"theme":"base","themeVariables":{"background":"#ffffff","primaryColor":"#E7F8F2","primaryBorderColor":"#0F766E","primaryTextColor":"#102A43","secondaryColor":"#E8F1FF","secondaryBorderColor":"#2563EB","secondaryTextColor":"#102A43","tertiaryColor":"#FFF4D6","tertiaryBorderColor":"#B45309","tertiaryTextColor":"#102A43","lineColor":"#0F766E","textColor":"#102A43","fontFamily":"Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"},"flowchart":{"curve":"basis","htmlLabels":true}}}%%
flowchart TD
    R1["Rung 1: Symbol cards<br/>~50-135 tokens per symbol<br/>always available"]
    R2["Rung 2: Skeleton IR<br/>~200 tokens per function<br/>signatures + control flow"]
    R3["Rung 3: Hot-path excerpt<br/>~500 tokens<br/>identifier-matched lines only"]
    R4["Rung 4: Full code window<br/>variable cost<br/>gated by proof-of-need"]

    R1 e1@-->|need more| R2
    R2 e2@-->|need more| R3
    R3 e3@-->|need more| R4

    classDef source fill:#E7F8F2,stroke:#0F766E,stroke-width:2px,color:#102A43;
    classDef process fill:#E8F1FF,stroke:#2563EB,stroke-width:2px,color:#102A43;
    classDef decision fill:#FFF4D6,stroke:#B45309,stroke-width:2px,color:#102A43;
    classDef storage fill:#F2E8FF,stroke:#7C3AED,stroke-width:2px,color:#102A43;
    classDef output fill:#FFE8EF,stroke:#BE123C,stroke-width:2px,color:#102A43;
    classDef muted fill:#F8FAFC,stroke:#64748B,stroke-width:1px,color:#102A43;
    classDef animate stroke:#0F766E,stroke-width:2px,stroke-dasharray:10\,5,stroke-dashoffset:900,animation:dash 22s linear infinite;
    class e1,e2,e3 animate;
```

### Skeleton (`src/code/skeleton.ts`)

Deterministic code outline using tree-sitter. Keeps imports, type declarations, and signatures verbatim. Elides function/class bodies. Supports all 12 indexed languages.

### Hot-Path (`src/code/hotpath.ts`)

Finds lines matching requested identifiers with configurable context lines before/after each match. Returns excerpt, matched line numbers, and which identifiers were found.

### Proof-of-Need Gating (`src/code/gate.ts`)

```mermaid
%%{init: {"theme":"base","themeVariables":{"background":"#ffffff","primaryColor":"#E7F8F2","primaryBorderColor":"#0F766E","primaryTextColor":"#102A43","secondaryColor":"#E8F1FF","secondaryBorderColor":"#2563EB","secondaryTextColor":"#102A43","tertiaryColor":"#FFF4D6","tertiaryBorderColor":"#B45309","tertiaryTextColor":"#102A43","lineColor":"#0F766E","textColor":"#102A43","fontFamily":"Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"},"flowchart":{"curve":"basis","htmlLabels":true}}}%%
flowchart TD
    Req["needWindow request<br/>symbolId + reason + expectedLines + identifiersToFind"]
    Engine["Policy engine<br/>priority 100 hard caps<br/>priority 90 identifiers required<br/>priority 80 budget enforcement<br/>priority 10 break-glass override"]
    Approve["Approve when one or more identifiers match,<br/>or the symbol is already in slice / frontier,<br/>or utility exceeds threshold,<br/>or break-glass is audited"]
    Deny["Denial returns reason, suggested alternative tool,<br/>and nextBestAction guidance"]

    Req e1@--> Engine
    Engine e2@--> Approve
    Engine e3@--> Deny

    classDef source fill:#E7F8F2,stroke:#0F766E,stroke-width:2px,color:#102A43;
    classDef process fill:#E8F1FF,stroke:#2563EB,stroke-width:2px,color:#102A43;
    classDef decision fill:#FFF4D6,stroke:#B45309,stroke-width:2px,color:#102A43;
    classDef storage fill:#F2E8FF,stroke:#7C3AED,stroke-width:2px,color:#102A43;
    classDef output fill:#FFE8EF,stroke:#BE123C,stroke-width:2px,color:#102A43;
    classDef muted fill:#F8FAFC,stroke:#64748B,stroke-width:1px,color:#102A43;
    classDef animate stroke:#0F766E,stroke-width:2px,stroke-dasharray:10\,5,stroke-dashoffset:900,animation:dash 22s linear infinite;
    class e1,e2,e3 animate;
```

---

## Delta & Blast Radius

`src/delta/` computes semantic diffs between ledger versions.

**Delta computation** (`diff.ts`) — compares two version snapshots, producing changed symbols with signature/invariant/side-effect diffs.

**Blast radius** (`blastRadius.ts`) ? BFS traversal of reverse dependency edges from changed symbols:

```mermaid
%%{init: {"theme":"base","themeVariables":{"background":"#ffffff","primaryColor":"#E7F8F2","primaryBorderColor":"#0F766E","primaryTextColor":"#102A43","secondaryColor":"#E8F1FF","secondaryBorderColor":"#2563EB","secondaryTextColor":"#102A43","tertiaryColor":"#FFF4D6","tertiaryBorderColor":"#B45309","tertiaryTextColor":"#102A43","lineColor":"#0F766E","textColor":"#102A43","fontFamily":"Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"},"flowchart":{"curve":"basis","htmlLabels":true}}}%%
flowchart TD
    Changed["Changed symbols"] e1@--> Reverse["Reverse-edge BFS<br/>imports + calls + config"]
    Reverse e2@--> Score["Scoring and ranking<br/>0.6 distance + 0.3 fanIn + 0.1 test proximity<br/>fan-in amplifiers flagged across versions"]

    classDef source fill:#E7F8F2,stroke:#0F766E,stroke-width:2px,color:#102A43;
    classDef process fill:#E8F1FF,stroke:#2563EB,stroke-width:2px,color:#102A43;
    classDef decision fill:#FFF4D6,stroke:#B45309,stroke-width:2px,color:#102A43;
    classDef storage fill:#F2E8FF,stroke:#7C3AED,stroke-width:2px,color:#102A43;
    classDef output fill:#FFE8EF,stroke:#BE123C,stroke-width:2px,color:#102A43;
    classDef muted fill:#F8FAFC,stroke:#64748B,stroke-width:1px,color:#102A43;
    classDef animate stroke:#0F766E,stroke-width:2px,stroke-dasharray:10\,5,stroke-dashoffset:900,animation:dash 22s linear infinite;
    class e1,e2 animate;
```

**PR risk analysis** (`src/mcp/tools/prRisk.ts`) — builds on blast radius to recommend test targets and flag high-risk changes.

---

## Live Indexing

The live index system (`src/live-index/`) provides draft-aware code intelligence for unsaved editor buffers.

```mermaid
%%{init: {"theme":"base","themeVariables":{"background":"#ffffff","primaryColor":"#E7F8F2","primaryBorderColor":"#0F766E","primaryTextColor":"#102A43","secondaryColor":"#E8F1FF","secondaryBorderColor":"#2563EB","secondaryTextColor":"#102A43","tertiaryColor":"#FFF4D6","tertiaryBorderColor":"#B45309","tertiaryTextColor":"#102A43","lineColor":"#0F766E","textColor":"#102A43","fontFamily":"Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"},"flowchart":{"curve":"basis","htmlLabels":true}}}%%
flowchart TD
    Editor["Editor<br/>VSCode, etc."] e1@--> Push["buffer.push<br/>on each keystroke or save"]
    Push e2@--> Overlay["Overlay store<br/>content, version, parseResult, dirty flag"]
    Overlay e3@--> Coordinator["Live index coordinator<br/>parse queue, reconcile queue,<br/>checkpoint service, idle monitor"]
    Coordinator e4@--> Reads["Merged into reads<br/>search, getCard, slice.build, getSkeleton"]

    classDef source fill:#E7F8F2,stroke:#0F766E,stroke-width:2px,color:#102A43;
    classDef process fill:#E8F1FF,stroke:#2563EB,stroke-width:2px,color:#102A43;
    classDef decision fill:#FFF4D6,stroke:#B45309,stroke-width:2px,color:#102A43;
    classDef storage fill:#F2E8FF,stroke:#7C3AED,stroke-width:2px,color:#102A43;
    classDef output fill:#FFE8EF,stroke:#BE123C,stroke-width:2px,color:#102A43;
    classDef muted fill:#F8FAFC,stroke:#64748B,stroke-width:1px,color:#102A43;
    classDef animate stroke:#0F766E,stroke-width:2px,stroke-dasharray:10\,5,stroke-dashoffset:900,animation:dash 22s linear infinite;
    class e1,e2,e3,e4 animate;
```

**Version conflict:** `upsertDraft()` rejects updates where `update.version < existing.version` — prevents out-of-order edits from overwriting newer content.

---

## Transport & Multi-Session

### stdio Transport (Default)

Single-session, used by CLI agents (Claude Code, etc.). One MCPServer instance handles all requests.

### HTTP Transport (`src/cli/transport/http.ts`)

Multi-session, per-session server isolation:

```mermaid
%%{init: {"theme":"base","themeVariables":{"background":"#ffffff","primaryColor":"#E7F8F2","primaryBorderColor":"#0F766E","primaryTextColor":"#102A43","secondaryColor":"#E8F1FF","secondaryBorderColor":"#2563EB","secondaryTextColor":"#102A43","tertiaryColor":"#FFF4D6","tertiaryBorderColor":"#B45309","tertiaryTextColor":"#102A43","lineColor":"#0F766E","textColor":"#102A43","fontFamily":"Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"},"flowchart":{"curve":"basis","htmlLabels":true}}}%%
flowchart TD
    Http["HTTP server<br/>POST /mcp"] e1@--> Sessions["SessionManager<br/>max 8 sessions<br/>reserve, register, idle reaper"]
    Sessions e4@--> Resources["Per-session resources<br/>transport map + MCPServer map"]
    Http e2@--> Rest["REST endpoints<br/>health, buffer, graph, symbol, UI"]
    Http e3@--> Events["EventStore<br/>message replay on reconnect<br/>FIFO eviction"]

    classDef source fill:#E7F8F2,stroke:#0F766E,stroke-width:2px,color:#102A43;
    classDef process fill:#E8F1FF,stroke:#2563EB,stroke-width:2px,color:#102A43;
    classDef decision fill:#FFF4D6,stroke:#B45309,stroke-width:2px,color:#102A43;
    classDef storage fill:#F2E8FF,stroke:#7C3AED,stroke-width:2px,color:#102A43;
    classDef output fill:#FFE8EF,stroke:#BE123C,stroke-width:2px,color:#102A43;
    classDef muted fill:#F8FAFC,stroke:#64748B,stroke-width:1px,color:#102A43;
    classDef animate stroke:#0F766E,stroke-width:2px,stroke-dasharray:10\,5,stroke-dashoffset:900,animation:dash 22s linear infinite;
    class e1,e2,e3,e4 animate;
```

Each connected client gets its own `MCPServer` instance, ensuring complete session isolation. The `SessionManager` enforces the 8-session limit and reaps idle connections.

---

## Concurrency Control

| Limiter         | Scope      | Max            | Timeout    | Purpose                        |
| :-------------- | :--------- | :------------- | :--------- | :----------------------------- |
| Tool dispatch   | Per-server | 8 concurrent   | 30s queue  | Prevents handler starvation    |
| DB write conn   | Global     | 1 (serialized) | —          | Graph integrity                |
| DB read pool    | Global     | 4 connections  | —          | Concurrent multi-session reads |
| Session manager | Global     | 8 sessions     | 5 min idle | Resource limits                |
| Summary batch   | Per-index  | 5 concurrent   | —          | API rate limiting              |

**ConcurrencyLimiter** (`src/util/concurrency.ts`) — generic queue-based limiter reused across the system.

---

## Semantic Engine

Three subsystems that enhance code intelligence beyond structural analysis:

### Pass-2 Call Resolution

11 language-specific resolvers that trace import chains and resolve raw call identifiers to symbolIds with confidence scores (0.0-1.0). See [Semantic Engine deep dive](./feature-deep-dives/semantic-engine.md).

### Embedding Search

Alpha-blended lexical + embedding similarity reranking using ONNX models. Three models available:

- **jina-embeddings-v2-base-code** (768-dim, ~110 MB, bundled) — code-optimized, zero-setup
- **nomic-embed-text-v1.5** (768-dim, ~138 MB, downloaded) — higher-quality text embeddings, longer context (8192 tokens), uses document/query prefixes
- **jina-embeddings-v2-base-code** (768-dim, ~110 MB, downloaded) — code-specialized for 30+ programming languages, 8192-token context

Nomic is a text model that benefit most from LLM summaries. Jina Code is trained on source code and excels at code-to-code similarity without requiring natural-language summaries.

### LLM Summaries

1-3 sentence semantic descriptions generated per symbol. Three providers (Anthropic API, OpenAI-compatible/Ollama, mock). Cached with content-addressed hashing. See [Indexing Languages deep dive](./feature-deep-dives/indexing-languages.md#llm-generated-summaries).

---

## Development Memories (Opt-In)

Graph-backed cross-session knowledge persistence. The memory subsystem is **opt-in and disabled by default**. When enabled, agents store decisions, bugfix context, and task notes as `Memory` nodes linked to symbols and files via `MEMORY_OF` and `MEMORY_OF_FILE` edges.

- **Opt-in** — disabled by default; enable via `"memory": { "enabled": true }` in config (global or per-repo)
- **Dual storage** — graph database (fast queries) + `.sdl-memory/*.md` files (version control)
- **Auto-surfacing** — when enabled, memories appear inside `slice.build` responses when they link to slice symbols
- **Staleness detection** — memories are flagged stale when linked symbols change during re-indexing
- **File import** — `.sdl-memory/` files are imported into the graph during `index.refresh` (when file sync is enabled)
- **4 MCP tools** — `memory.store`, `memory.query`, `memory.remove`, `memory.surface` (only available when memory is enabled)

See [Development Memories deep dive](./feature-deep-dives/development-memories.md).

---

## Sandboxed Runtime Execution

`sdl.runtime.execute` runs repo-scoped commands under SDL-MCP governance instead of uncontrolled shell access. 16 runtimes are supported (Node, Python, Go, Java, Rust, C, C++, C#, Kotlin, PHP, Ruby, Perl, R, Elixir, Shell, TypeScript).

```mermaid
%%{init: {"theme":"base","themeVariables":{"background":"#ffffff","primaryColor":"#E7F8F2","primaryBorderColor":"#0F766E","primaryTextColor":"#102A43","secondaryColor":"#E8F1FF","secondaryBorderColor":"#2563EB","secondaryTextColor":"#102A43","tertiaryColor":"#FFF4D6","tertiaryBorderColor":"#B45309","tertiaryTextColor":"#102A43","lineColor":"#0F766E","textColor":"#102A43","fontFamily":"Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"},"flowchart":{"curve":"basis","htmlLabels":true}}}%%
flowchart TD
    Request["runtime.execute request"]
    Validate["runtime enabled?<br/>allowed runtime?<br/>valid executable?"]
    Sandbox["repo-jail cwd<br/>environment scrubbing<br/>timeout enforcement<br/>concurrency limits"]
    Capture["capture stdout/stderr<br/>persist gzip artifact<br/>return artifactHandle"]

    Request e1@--> Validate
    Validate e2@--> Sandbox
    Sandbox e3@--> Capture

    classDef source fill:#E7F8F2,stroke:#0F766E,stroke-width:2px,color:#102A43;
    classDef process fill:#E8F1FF,stroke:#2563EB,stroke-width:2px,color:#102A43;
    classDef decision fill:#FFF4D6,stroke:#B45309,stroke-width:2px,color:#102A43;
    classDef storage fill:#F2E8FF,stroke:#7C3AED,stroke-width:2px,color:#102A43;
    classDef output fill:#FFE8EF,stroke:#BE123C,stroke-width:2px,color:#102A43;
    classDef muted fill:#F8FAFC,stroke:#64748B,stroke-width:1px,color:#102A43;
    classDef animate stroke:#0F766E,stroke-width:2px,stroke-dasharray:10\,5,stroke-dashoffset:900,animation:dash 22s linear infinite;
    class e1,e2,e3 animate;
```

The `outputMode` parameter controls response verbosity:

- **`minimal`** (default): ~50 tokens — just status + artifact handle
- **`summary`**: ~200-500 tokens — head + tail excerpts
- **`intent`**: variable — only `queryTerms`-matched excerpts

`sdl.runtime.queryOutput` enables on-demand keyword search of stored artifacts without loading full output into context.

See [Runtime Execution deep dive](./feature-deep-dives/runtime-execution.md).

---

## Token Usage Tracking

SDL-MCP tracks per-call and cumulative token savings via sideband `_tokenUsage` metadata. Each tool response includes a savings comparison (SDL tokens vs. raw-file equivalent). `sdl.usage.stats` returns session and lifetime statistics from LadybugDB.

MCP logging notifications emit per-call savings meters and end-of-task session summaries.

---

## Observability Service

`src/observability/` is a side-channel observer that aggregates the existing telemetry stream and adds runtime probes (CPU, RSS, heap, event-loop lag, write-pool depth, indexer drain depth) for per-repo dashboards. The `ObservabilityTap` interface receives forwarded `log*` events from `src/mcp/telemetry.ts`; the singleton `ObservabilityService` owns one `Aggregator` per repo with dual retention windows (short, default 15 min; long, default 24 h) and a sampling tick at `observability.sampleIntervalMs` (default 2000 ms). A separate `BeamExplainStore` LRU keeps the most-recent beam-search decision traces. The whole subsystem is exposed via bearer-auth-gated `/api/observability/{snapshot,timeseries,beam-explain,stream}` routes plus the `/ui/observability` HTML/JS/CSS surface in the HTTP transport. As an outbound observer it sits **outside the request path** of MCP tool dispatch — no observability code runs synchronously inside a handler, and observability failures cannot block tool calls. See [Observability Dashboard deep dive](./feature-deep-dives/observability-dashboard.md).

---

## Error Handling

**Typed errors** (`src/domain/errors.ts`):

- `ConfigError`, `DatabaseError`, `ValidationError`, `IndexError`, `PolicyError`, `NotFoundError`
- `errorToMcpResponse()` (in `src/mcp/errors.ts`) converts any error to MCP-safe JSON

**Policy denials** include actionable guidance:

```
{
  "error": {
    "message": "Window exceeds 180 line limit",
    "code": "POLICY_ERROR",
    "nextBestAction": "requestSkeleton",
    "requiredFieldsForNext": { "symbolId": "sym-1", "repoId": "repo-1" }
  }
}
```

**Graceful degradation:**

- Rust native indexer unavailable → falls back to tree-sitter TS
- ONNX runtime unavailable → falls back to mock embeddings
- LLM API unavailable → skips summary generation (uses heuristic)
- Live index disabled → reads from persisted DB only

---

## Source Directory Map

Current command/tool registration notes:

- CLI commands: 13 (`init`, `doctor`, `info`, `index`, `serve`, `version`, `export`, `import`, `pull`, `benchmark:ci`, `summary`, `health`, `tool`)
- Gateway mode keeps `sdl.action.search` and `sdl.info` outside the 4 namespace tools
- Code Mode adds `sdl.manual`, `sdl.context`, `sdl.workflow`, and `sdl.file`, or can run exclusive with `sdl.action.search`, `sdl.manual`, `sdl.context`, `sdl.workflow`, and `sdl.file`

```mermaid
%%{init: {"theme":"base","themeVariables":{"background":"#ffffff","primaryColor":"#E7F8F2","primaryBorderColor":"#0F766E","primaryTextColor":"#102A43","secondaryColor":"#E8F1FF","secondaryBorderColor":"#2563EB","secondaryTextColor":"#102A43","tertiaryColor":"#FFF4D6","tertiaryBorderColor":"#B45309","tertiaryTextColor":"#102A43","lineColor":"#0F766E","textColor":"#102A43","fontFamily":"Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"},"flowchart":{"curve":"basis","htmlLabels":true}}}%%
flowchart TD
    Src["src/"] e1@--> Entry["main.ts, server.ts"]
    Src e2@--> CLI["cli/<br/>commands, transport"]
    Src e3@--> Config["config/<br/>types.ts"]
    Src e4@--> DB["db/<br/>schema, init, query modules"]
    Src e5@--> Domain["domain/<br/>types, errors"]
    Src e6@--> Indexer["indexer/<br/>adapters, pass2, embeddings, watcher"]
    Src e7@--> Graph["graph/<br/>slice builder"]
    Src e8@--> Delta["delta/<br/>diff, blastRadius"]
    Src e9@--> Code["code/<br/>skeleton, hotpath, gate, windows"]
    Src e10@--> CodeMode["code-mode/<br/>workflow, manual, action catalog, ladder validator"]
    Src e11@--> Gateway["gateway/<br/>router, thin-schemas, compact-schema"]
    Src e12@--> Agent["agent/<br/>context engine, planner, evidence"]
    Src e13@--> Policy["policy/<br/>engine"]
    Src e14@--> Live["live-index/<br/>overlay store, coordinator, checkpoint, idle monitor"]
    Src e15@--> Memory["memory/<br/>surface, file-sync"]
    Src e16@--> Runtime["runtime/<br/>executor, runtimes"]
    Src e17@--> Services["services/<br/>summary, health, card-builder"]
    Src e18@--> Sync["sync/<br/>sync, pull"]
    Src e19@--> Startup["startup/<br/>bootstrap"]
    Src e20@--> Benchmark["benchmark/<br/>threshold, regression"]
    Src e21@--> MCP["mcp/<br/>tools, errors, telemetry, token-usage, session-manager, dispatch-limiter"]
    Src e22@--> Util["util/<br/>paths, concurrency, hashing, tokenizer"]

    classDef source fill:#E7F8F2,stroke:#0F766E,stroke-width:2px,color:#102A43;
    classDef process fill:#E8F1FF,stroke:#2563EB,stroke-width:2px,color:#102A43;
    classDef decision fill:#FFF4D6,stroke:#B45309,stroke-width:2px,color:#102A43;
    classDef storage fill:#F2E8FF,stroke:#7C3AED,stroke-width:2px,color:#102A43;
    classDef output fill:#FFE8EF,stroke:#BE123C,stroke-width:2px,color:#102A43;
    classDef muted fill:#F8FAFC,stroke:#64748B,stroke-width:1px,color:#102A43;
    classDef animate stroke:#0F766E,stroke-width:2px,stroke-dasharray:10\,5,stroke-dashoffset:900,animation:dash 22s linear infinite;
    class e1,e2,e3,e4,e5,e6,e7,e8,e9,e10,e11,e12,e13,e14,e15,e16,e17,e18,e19,e20,e21,e22 animate;
```

## Component Diagram

```mermaid
%%{init: {"theme":"base","themeVariables":{"background":"#ffffff","primaryColor":"#E7F8F2","primaryBorderColor":"#0F766E","primaryTextColor":"#102A43","secondaryColor":"#E8F1FF","secondaryBorderColor":"#2563EB","secondaryTextColor":"#102A43","tertiaryColor":"#FFF4D6","tertiaryBorderColor":"#B45309","tertiaryTextColor":"#102A43","lineColor":"#0F766E","textColor":"#102A43","fontFamily":"Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"},"flowchart":{"curve":"basis","htmlLabels":true}}}%%
graph TD
    A[Repository Files] e1@--> B[Indexer Engine]
    B e2@--> |Pass-1: Symbols, Imports, Calls| C[LadybugDB Graph]

    E[Editor Buffers] e3@--> F[Live Overlay Store]
    F e4@-.-> |Merged at read time| C

    C e5@--> G[Pass-2: Call Resolver Registry]
    G e6@--> |Resolved edges + confidence| C

    C e7@--> H[Cluster Detection + Process Tracing]
    H e8@--> C

    C e9@--> I[Embedding Pipeline + LLM Summaries]
    I e10@--> C

    C e11@--> J[MCP Tool Layer]

    subgraph Tool Registration Modes
        J1[Flat Mode: 33 tools]
        J2[Gateway Mode: 6 tools]
        J3[Code Mode adds manual, context, and workflow]
    end
    J e12@--- J1
    J e13@--- J2
    J e14@--- J3

    J e15@--> K[Iris Gate Ladder]
    K e16@--> |Cards → Skeleton → HotPath → Window| L[AI Agent]

    J e17@--> M[Graph Slicing]
    M e18@--> |Beam search + budget| L

    J e19@--> N[Delta + Blast Radius]
    N e20@--> |Changed symbols + impact| L

    J e21@--> O[Agent Context]
    O e22@--> |Task-shaped rung planning| L

    J e23@--> U[Runtime Execution]
    U e24@--> |Sandboxed code execution| L

    L e25@--> P[Agent Feedback]
    P e26@--> C

    J e27@--> T[Development Memories]
    T e28@--> |Store/surface memories| C
    T e29@--> |Auto-surface in slices| L

    J e30@--> V[Usage Stats]
    V e31@--> |Token savings tracking| L

    Q[Policy Engine] e32@-.-> |Gates code windows| K
    R[Session Manager] e33@-.-> |Max 8 sessions| J
    S[Dispatch Limiter] e34@-.-> |Max 8 concurrent| J

    classDef source fill:#E7F8F2,stroke:#0F766E,stroke-width:2px,color:#102A43;
    classDef process fill:#E8F1FF,stroke:#2563EB,stroke-width:2px,color:#102A43;
    classDef decision fill:#FFF4D6,stroke:#B45309,stroke-width:2px,color:#102A43;
    classDef storage fill:#F2E8FF,stroke:#7C3AED,stroke-width:2px,color:#102A43;
    classDef output fill:#FFE8EF,stroke:#BE123C,stroke-width:2px,color:#102A43;
    classDef muted fill:#F8FAFC,stroke:#64748B,stroke-width:1px,color:#102A43;
    classDef animate stroke:#0F766E,stroke-width:2px,stroke-dasharray:10\,5,stroke-dashoffset:900,animation:dash 22s linear infinite;
    class e1,e2,e3,e4,e5,e6,e7,e8,e9,e10,e11,e12,e13,e14,e15,e16,e17,e18,e19,e20,e21,e22,e23,e24,e25,e26,e27,e28,e29,e30,e31,e32,e33,e34 animate;
```

Registration-mode counts in the current implementation:

- Flat mode: 33 tools
- Gateway-only mode: 6 tools
- Gateway + legacy mode: 37 tools
- Code Mode adds `sdl.manual`, `sdl.context`, `sdl.workflow`, and `sdl.file`

[Back to README](../README.md)
