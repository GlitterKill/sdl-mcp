import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { proveSourceOccurrenceCall } from "../../dist/indexer/provider-first/source-call-proof.js";

describe("proveSourceOccurrenceCall", () => {
  it("proves Rust Analyzer PartialEq eq references over multi-line == spans", () => {
    const result = proveSourceOccurrenceCall({
      providerSymbolId:
        "rust-analyzer cargo scip-io-core 0.1.9 cmake_compile_databases/impl#[CmakeCompileDatabaseJobStatus][`PartialEq<Self>`]eq().",
      relPath: "crates/scip-io-cli/src/cli/index.rs",
      range: { startLine: 0, startCol: 22, endLine: 1, endCol: 16 },
      expectedNames: ["eq"],
      sourceLines: new Map([
        [0, "            job.status"],
        [
          1,
          "                == scip_io_core::cmake_compile_databases::CmakeCompileDatabaseJobStatus::Existing",
        ],
      ]),
    });

    assert.deepEqual(result, {
      matched: true,
      line:
        "                == scip_io_core::cmake_compile_databases::CmakeCompileDatabaseJobStatus::Existing",
      invocationEndLine: 1,
    });
  });

  it("maps SCIP UTF-8 byte columns before slicing source text", () => {
    const line = "const π = target();";
    const prefix = "const π = ";
    const expectedName = "target";
    const startCol = Buffer.byteLength(prefix, "utf8");
    const endCol = startCol + Buffer.byteLength(expectedName, "utf8");

    const result = proveSourceOccurrenceCall({
      providerSymbolId:
        "scip-typescript npm fixture 1.0.0 src/index.ts/target().",
      relPath: "src/index.ts",
      range: { startLine: 0, startCol, endLine: 0, endCol },
      expectedNames: [expectedName],
      sourceLines: new Map([[0, line]]),
    });

    assert.deepEqual(result, {
      matched: true,
      line,
      invocationEndLine: 0,
    });
  });
});
