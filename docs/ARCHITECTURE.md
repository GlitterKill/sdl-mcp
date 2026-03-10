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
- [Iris Gate Ladder](./IRIS_GATE_LADDER.md)
- [Architecture (this page)](./ARCHITECTURE.md)
- [Legacy User Guide](./USER_GUIDE.md)

</details>
</div>

SDL-MCP is a high-performance codebase indexing and context retrieval server. This document outlines the technical stack and the lifecycle of a code symbol as it moves through the system.

## Technical Stack

- **Runtime:** Node.js (v20+) / TypeScript (v5.9+)
- **Core Database:** **LadybugDB** (In-process Graph Database)
  - Stores the "Symbol Graph": nodes (Symbols, Files, Repos) and edges (Calls, Imports).
- **Indexing Engines:**
  - **Native Engine (Rust):** High-performance multi-threaded pass-1 extraction (via `napi-rs`).
  - **Tree-sitter:** Used for fallback parsing, specialized language adapters, and skeleton generation.
- **MCP Framework:** `@modelcontextprotocol/sdk`
- **Protocol Transports:** `stdio` (for CLI agents) and `http` (for network-connected tools).
- **Validation:** Zod schemas for all tool payloads and responses.

---

## Data Flow Architecture

The SDL-MCP lifecycle consists of three primary phases: **Ingestion**, **Graph Enrichment**, and **Context Retrieval**.

### 1. Ingestion Phase (The "Pass-1")
When a repository is indexed (via `sdl-mcp index` or `sdl.index.refresh`):
1. **File Scanning:** Files are identified using `fast-glob` and matched against the configured language adapters.
2. **Pass-1 Extraction:** The indexer parses files into ASTs using Tree-sitter. It extracts **Symbol Cards**:
   - Metadata (name, kind, visibility, range).
   - AST Fingerprints (used for content-addressed identity).
   - Local dependency hints (imports and raw call identifiers).
3. **Draft Overlay:** If the Live Editor is active, buffer updates are stored in an **Overlay Store** before being committed to the durable LadybugDB.

### 2. Graph Enrichment (The "Pass-2")
Once raw symbols are in the graph, the Pass-2 resolver builds the global dependency web:
1. **Semantic Call Resolution:** Identifiers extracted in Pass-1 are resolved to specific `symbolId`s using cross-file import maps and scope analysis.
2. **Community Detection (Clusters):** The graph is analyzed to identify "clusters" of highly-coupled symbols (e.g., all symbols in a specific module or feature).
3. **Call-Chain Tracing (Processes):** Sequential call paths are traced to identify entry points and hot paths.
4. **Summary Generation:** LLMs generate concise semantic summaries for symbols based on their implementation and role in the graph.

### 3. Context Retrieval (The "Iris Gate")
When an agent requests context:
1. **Graph Slicing:** A `slice.build` request starts from "entry symbols" and traverses the graph up to a token budget. Slices are ranked by relevance scores (e.g., fan-in, centrality, and search term proximity).
2. **Escalation Ladder:** The agent escalates through the **Iris Gate Ladder** (Cards -> Skeletons -> Hot-Paths -> Windows).
3. **Policy Gating:** Every `needWindow` request is checked against the project's security policy.
4. **Feedback Loop:** Agents provide feedback via `sdl.agent.feedback`, which re-ranks symbols in the graph for future slices.

---

## Component Diagram

```mermaid
graph TD
    A[Repository Files] --> B[Indexer Engine (Rust/TS)]
    B --> C[Pass-1: Raw Symbols]
    C --> D[LadybugDB Graph]
    E[Editor Buffers] --> F[Live Overlay Store]
    F -.-> D
    D --> G[Pass-2: Call Resolver]
    G --> D
    D --> H[Cluster/Process Analyzers]
    H --> D
    D --> I[MCP Tool Layer]
    I --> J[Iris Gate Ladder]
    J --> K[AI Agent (Claude Code/Desktop)]
    K --> L[Agent Feedback]
    L --> D
```
