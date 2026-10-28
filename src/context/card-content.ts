import { SYMBOL_CARD_SUMMARY_MAX_CHARS_LIGHT } from "../config/constants.js";
import type { SymbolRow } from "../db/ladybug-symbols.js";
import type { SymbolCard } from "../domain/types.js";
import { toSignatureCard } from "../graph/slice/slice-serializer.js";
import { safeJsonParse, SignatureSchema } from "../util/safeJson.js";
import { parseTestCaseFacetJson } from "../util/test-case.js";
import { estimateTokens } from "../util/tokenize.js";

export function projectCardContent(card: SymbolCard): Record<string, unknown> {
  return {
    kind: card.kind,
    name: card.name,
    ...(card.signature ? { signature: card.signature } : {}),
    ...(card.summary?.trim() ? { summary: card.summary } : {}),
    ...(card.testCase ? { testCase: card.testCase } : {}),
  };
}

/** Mirror signature-detail hydration using metadata already in the read snapshot. */
export function estimateSymbolCardContentTokens(symbol: SymbolRow): number {
  const signature = symbol.signatureJson
    ? safeJsonParse(symbol.signatureJson, SignatureSchema, { name: symbol.name })
    : { name: symbol.name };
  const card = toSignatureCard({
    symbolId: symbol.symbolId,
    repoId: symbol.repoId,
    file: "",
    range: {
      startLine: symbol.rangeStartLine,
      startCol: symbol.rangeStartCol,
      endLine: symbol.rangeEndLine,
      endCol: symbol.rangeEndCol,
    },
    kind: symbol.kind as SymbolCard["kind"],
    name: symbol.name,
    exported: symbol.exported,
    signature: signature as unknown as SymbolCard["signature"],
    summary: symbol.summary?.slice(0, SYMBOL_CARD_SUMMARY_MAX_CHARS_LIGHT),
    testCase: parseTestCaseFacetJson(symbol.testCaseJson),
    deps: { imports: [], calls: [] },
    version: { ledgerVersion: "", astFingerprint: symbol.astFingerprint },
  });
  return estimateTokens(JSON.stringify(projectCardContent(card)));
}
