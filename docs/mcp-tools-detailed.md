# MCP tools detailed reference

The canonical reference for SDL-MCP tools is the [MCP Tools Reference](./mcp-tools-reference.md).

It documents the current flat, gateway, and Code Mode surfaces, request and response behavior, and recommended workflows. The [Generated Tool Inventory](./generated/tool-inventory.md) remains the source of truth for registered tool names and mode counts.

This page remains at its original URL so existing links continue to work.

## Repository removal

Use `repo.unregister` only for runtime registrations. It requires `confirmRepoId` to exactly match `repoId`, rejects configured repositories until their entry is removed from `SDL_CONFIG`, and rejects dirty live buffers unless `discardDrafts: true` is explicit. Successful removal returns only `{ ok: true, repoId, removed: true }` and deletes repository-owned graph data while preserving unrelated repositories and global content-addressed nodes.

## Find the right guide

- [MCP Tools Reference](./mcp-tools-reference.md): tool parameters, responses, and usage guidance.
- [Code Mode](./feature-deep-dives/code-mode.md): compact discovery, retrieval, file, and workflow wrappers.
- [CLI Tool Access](./feature-deep-dives/cli-tool-access.md): direct CLI action aliases and output formats.
- [File Read](./file-read-tool.md), [File Write](./file-write-tool.md), [Search Edit](./search-edit-tool.md), and [Symbol Edit](./symbol-edit-tool.md): focused file and edit guidance.
- [Tool Gateway](./feature-deep-dives/tool-gateway.md): namespace routing and registration modes.

[Back to Documentation Hub](./README.md)
