import assert from "node:assert/strict";
import { it } from "node:test";
import {
  importAliasSourceTextCandidates,
  normalizeScipProviderFacts,
} from "../../dist/indexer/provider-first/scip-normalizer.js";
import {
  collectNeededSourceLines,
  selectNeededLines,
} from "../../dist/indexer/provider-first/scip-source-lines.js";
import type { ScipDocument, ScipOccurrence } from "../../dist/scip/types.js";

it("proves the lsp-io Rust write_sdl_mcp_config_file alias at commands.rs:295", () => {
  const target =
    "rust-analyzer cargo lsp-io-core 0.1.1 sdl_mcp/write_sdl_mcp_config().";
  const caller =
    "rust-analyzer cargo lsp-io-gui 0.1.1 commands/write_sdl_mcp_config().";
  const relPath = "src-tauri/src/commands.rs";
  const lines = Array<string>(316).fill("");
  lines[3] = "use lsp_io_core::sdl_mcp::{";
  lines[4] =
    "    SdlMcpExportOptions, build_sdl_mcp_export, write_sdl_mcp_config as write_sdl_mcp_config_file,";
  lines[5] = "};";
  lines[285] = "pub async fn write_sdl_mcp_config() {";
  lines[294] = "    let result = write_sdl_mcp_config_file(";
  lines[295] = "    );";
  lines[315] = "}";

  const occurrence = (
    symbol: string,
    startLine: number,
    startCol: number,
    endCol: number,
    symbolRoles = 0,
  ): ScipOccurrence => ({
    symbol,
    range: { startLine, startCol, endLine: startLine, endCol },
    symbolRoles,
    overrideDocumentation: [],
    syntaxKind: 0,
    diagnostics: [],
  });
  const documents: ScipDocument[] = [
    {
      language: "rust",
      relativePath: "crates/lsp-io-core/src/sdl_mcp.rs",
      symbols: [
        {
          symbol: target,
          displayName: "write_sdl_mcp_config",
          kind: 17,
          documentation: [],
          relationships: [],
        },
      ],
      occurrences: [occurrence(target, 233, 7, 27, 1)],
    },
    {
      language: "rust",
      relativePath: relPath,
      symbols: [
        {
          symbol: caller,
          displayName: "write_sdl_mcp_config",
          kind: 17,
          documentation: [],
          relationships: [],
        },
      ],
      occurrences: [
        // rust-analyzer emits ordinary references for both import tokens.
        occurrence(target, 4, 47, 67),
        occurrence(target, 4, 71, 96),
        {
          ...occurrence(caller, 285, 13, 33, 1),
          enclosingRange: {
            startLine: 285,
            startCol: 0,
            endLine: 315,
            endCol: 1,
          },
        },
        occurrence(target, 294, 17, 42),
      ],
    },
  ];
  const needed = collectNeededSourceLines(documents).get(relPath)!;
  const facts = normalizeScipProviderFacts({
    repoId: "lsp-io",
    generationId: "rust-alias-regression",
    providerId: "scip-io",
    documents,
    sourceLinesByPath: new Map([
      [relPath, selectNeededLines(lines.join("\n"), needed)],
    ]),
  });
  const coverage = facts.coverage.find((entry) => entry.relPath === relPath)!;
  assert.equal(coverage.callProofUnavailableReferences, 0);
  assert.deepEqual(coverage.callProofUnavailableReasons ?? [], []);
  assert.deepEqual(coverage.callProofUnavailableSamples ?? [], []);
  const calls = facts.edges.filter((edge) => edge.edgeType === "call");
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].targetSymbolId,
    facts.symbols.find((symbol) => symbol.providerSymbolId === target)!
      .symbolId,
  );
  assert.equal(
    calls[0].sourceSymbolId,
    facts.symbols.find((symbol) => symbol.providerSymbolId === caller)!
      .symbolId,
  );
});

it("recognizes Rust use aliases without treating casts as imports", () => {
  for (const declaration of [
    "use crate::write_sdl_mcp_config as write_sdl_mcp_config_file;",
    "pub(crate) use crate::{write_sdl_mcp_config as write_sdl_mcp_config_file};",
  ]) {
    const lines = new Map([[0, declaration]]);
    assert.deepEqual(
      importAliasSourceTextCandidates(lines, 0, "write_sdl_mcp_config"),
      ["write_sdl_mcp_config_file"],
    );
    assert.deepEqual(
      importAliasSourceTextCandidates(lines, 0, "write_sdl_mcp_config_file"),
      ["write_sdl_mcp_config_file"],
    );
    assert.deepEqual(
      importAliasSourceTextCandidates(lines, 0, "unrelated"),
      [],
    );
  }
  const lines = new Map([
    [0, "use crate::original as imported;"],
    [1, "let value = original as unrelated;"],
  ]);
  assert.deepEqual(importAliasSourceTextCandidates(lines, 1, "unrelated"), []);
});
