import { it } from "node:test";
import assert from "node:assert/strict";
import { sourceTextCandidatesForScipSymbol } from "../../dist/indexer/provider-first/scip-normalizer.js";
import { proveSourceOccurrenceCall } from "../../dist/indexer/provider-first/source-call-proof.js";

it("proves Kotlin companion invoke and escaped constructor names without accepting unrelated names", () => {
  const prove = (symbol: string, name: string, text: string) => proveSourceOccurrenceCall({
    providerSymbolId: symbol, expectedNames: sourceTextCandidatesForScipSymbol(symbol, name),
    relPath: "Fixture.kt", range: { startLine: 0, startCol: 0, endLine: 0, endCol: text.length },
    sourceLines: new Map([[0, text + "()"]]),
  });
  const invoke = "semanticdb maven fixture 1 example/Factory#Companion#invoke().";
  assert.equal(prove(invoke, "invoke", "Factory").matched, true);
  assert.equal(prove(invoke, "invoke", "OtherFactory").matched, false);
  assert.equal(prove(invoke.replace("invoke", "create"), "create", "Factory").matched, false);
  const ctor = "semanticdb maven fixture 1 example/`-Reader`#`<init>`().";
  assert.equal(prove(ctor, "<init>", "`-Reader`").matched, true);
  assert.equal(prove(ctor, "<init>", "`-Writer`").matched, false);
  assert.equal(prove(ctor, "<init>", "`-Reader").matched, false);
});
