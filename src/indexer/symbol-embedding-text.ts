/**
 * Model-aware symbol embedding text builders.
 *
 * Phase 2: Jina structured payload with graph context.
 * Phase 3 will add Nomic builder and dispatcher.
 *
 * These builders transform PreparedSymbolEmbeddingInput into model-optimized
 * text payloads. Each model receives a payload shape tuned to its training:
 * - Jina (code-specialized): structured labeled sections
 * - Nomic (general text): natural-language prose (Phase 3)
 */
import type { PreparedSymbolEmbeddingInput } from "./symbol-embedding-context.js";

/**
 * Build a structured embedding payload for Jina code models.
 *
 * Produces multiline text with fixed sections in this order:
 * 1. Symbol header: name, kind, language
 * 2. Path and visibility/export status
 * 3. Signature
 * 4. Summary (only when fresh and trusted)
 * 5. Role tags
 * 6. Invariants
 * 7. Side effects
 * 8. Imports (outgoing only)
 * 9. Calls (outgoing only)
 * 10. Lexical/search terms
 *
 * Uses plain labeled lines, not JSON blobs or raw symbol IDs.
 * Sections with no data are omitted entirely.
 */
export function buildJinaSymbolEmbeddingText(
  input: PreparedSymbolEmbeddingInput,
): string {
  const lines: string[] = [];

  // 1. Symbol header: name, kind, language
  lines.push(`Name: ${input.symbol.name}`);
  lines.push(`Kind: ${input.symbol.kind}`);
  if (input.language) {
    lines.push(`Language: ${input.language}`);
  }

  // 2. Path and visibility/export status
  if (input.relPath) {
    lines.push(`Path: ${input.relPath}`);
  }
  lines.push(`Exported: ${input.symbol.exported ? "yes" : "no"}`);

  // 3. Signature
  if (input.signatureText) {
    lines.push(`Signature: ${input.signatureText}`);
  }

  // 4. Summary (only when fresh)
  if (input.summaryFreshness === "fresh" && input.summaryText) {
    lines.push(`Summary: ${input.summaryText}`);
  }

  // 5. Role tags
  if (input.roleTags.length > 0) {
    lines.push(`Roles: ${input.roleTags.join(", ")}`);
  }

  // 6. Invariants (bullet list)
  if (input.invariants.length > 0) {
    lines.push("Invariants:");
    for (const inv of input.invariants) {
      lines.push(`- ${inv}`);
    }
  }

  // 7. Side effects (bullet list)
  if (input.sideEffects.length > 0) {
    lines.push("Side effects:");
    for (const se of input.sideEffects) {
      lines.push(`- ${se}`);
    }
  }

  // 8. Imports (outgoing only, as comma-separated labels)
  if (input.imports.length > 0) {
    const importLabels = input.imports.map((i) => i.label);
    lines.push(`Imports: ${importLabels.join(", ")}`);
  }

  // 9. Calls (outgoing only, as comma-separated labels)
  if (input.calls.length > 0) {
    const callLabels = input.calls.map((c) => c.label);
    lines.push(`Calls: ${callLabels.join(", ")}`);
  }

  // 10. Lexical/search terms
  if (input.searchTerms.length > 0) {
    lines.push(`Terms: ${input.searchTerms.join(", ")}`);
  }

  return lines.join("\n");
}

// Phase 3 extension point:
// - buildNomicSymbolEmbeddingText(input) — natural-language prose payload
// - buildSymbolEmbeddingText(model, input) — dispatcher selecting Jina/Nomic/fallback
