/**
 * Model-aware symbol embedding text builders.
 *
 * Phase 2: Jina structured payload with graph context.
 * Phase 3: Broader model-aware payload split (Nomic builder + dispatcher).
 *
 * These builders transform PreparedSymbolEmbeddingInput into model-optimized
 * text payloads. Each model receives a payload shape tuned to its training:
 * - Jina (code-specialized): structured labeled sections
 * - Nomic (general text): natural-language prose
 */
import { SYMBOL_CARD_SUMMARY_MAX_CHARS } from "../config/constants.js";
import type { PreparedSymbolEmbeddingInput } from "./symbol-embedding-context.js";


export const CONCISE_SYMBOL_SUMMARY_BUILDER_VERSION = "concise-symbol-summary-v1";

function firstNonEmpty(values: readonly string[]): string | null {
  for (const value of values) {
    const normalized = value.replace(/\s+/g, " ").trim();
    if (normalized.length > 0) {
      return normalized;
    }
  }
  return null;
}

function stripTrailingSentencePunctuation(value: string): string {
  return value.replace(/[.;:]$/u, "").trim();
}

function capSummary(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= SYMBOL_CARD_SUMMARY_MAX_CHARS) {
    return oneLine;
  }
  return `${oneLine.slice(0, SYMBOL_CARD_SUMMARY_MAX_CHARS - 3).trimEnd()}...`;
}

function normalizeReturnType(value: string | undefined): string | null {
  const normalized = value?.replace(/\s+/g, " ").trim();
  if (!normalized || /^(?:void|undefined|never)$/i.test(normalized)) {
    return null;
  }
  return normalized;
}

function extractObviousReturnType(signatureText: string | null): string | null {
  const signature = signatureText?.replace(/\s+/g, " ").trim();
  if (!signature) {
    return null;
  }

  const tsReturn = signature.match(/\)\s*:\s*([^;={]+?)(?=\s*(?:=>|\{|$))/u);
  if (tsReturn) {
    return normalizeReturnType(tsReturn[1]);
  }

  const rustReturn = signature.match(/->\s*([^;={]+?)(?=\s*(?:where|\{|$))/u);
  if (rustReturn) {
    return normalizeReturnType(rustReturn[1]);
  }

  const goReturn = signature.match(
    /\)\s*(?:\(([^)]*)\)|([A-Za-z_][\w.\[\]*<>]*(?:\s*,\s*[A-Za-z_][\w.\[\]*<>]*)?))\s*(?=\{|$)/u,
  );
  if (goReturn) {
    return normalizeReturnType(goReturn[1] ?? goReturn[2]);
  }

  return null;
}

/**
 * Builds deterministic one-sentence prose for mock summary generation.
 * The output intentionally avoids dependency lists so mock summaries stay short.
 */
export function buildConciseSymbolSummary(
  input: PreparedSymbolEmbeddingInput,
): string {
  const kind = (input.symbol.kind ?? "symbol").trim() || "symbol";
  const name = (input.symbol.name ?? "symbol").trim() || "symbol";
  const role = firstNonEmpty(input.roleTags);
  const returnType = extractObviousReturnType(input.signatureText);
  const sideEffect = firstNonEmpty(input.sideEffects);

  const clauses = [
    `${kind} ${name}${role ? ` ${stripTrailingSentencePunctuation(role)}` : ""}`,
  ];
  if (returnType) {
    clauses.push(`returns ${returnType}`);
  }
  if (sideEffect) {
    clauses.push(stripTrailingSentencePunctuation(sideEffect));
  }

  return capSummary(`${clauses.join("; ")}.`);
}

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

/**
 * Build a natural-language embedding payload for Nomic text models.
 *
 * Produces prose-oriented text that describes the symbol in natural language,
 * suitable for general-purpose text embedding models. Uses the same prepared
 * fields as Jina but renders them as readable statements rather than labeled
 * sections.
 *
 * Content structure:
 * - Symbol identity as prose ("A function named X in path/to/file")
 * - Signature and summary
 * - Role tags and lexical terms as descriptive phrases
 * - Import/call context phrased as "uses" or "relies on" statements
 */
export function buildNomicSymbolEmbeddingText(
  input: PreparedSymbolEmbeddingInput,
): string {
  const parts: string[] = [];

  // Symbol identity as natural prose
  const kindArticle = /^[aeiou]/i.test(input.symbol.kind ?? "x") ? "An" : "A";
  let identity = `${kindArticle} ${input.symbol.kind} named ${input.symbol.name}`;
  if (input.relPath) {
    identity += ` in ${input.relPath}`;
  }
  if (input.language) {
    identity += ` (${input.language})`;
  }
  parts.push(identity + ".");

  // Signature as prose
  if (input.signatureText) {
    parts.push(`Defined as: ${input.signatureText}`);
  }

  // Summary (only when fresh)
  if (input.summaryFreshness === "fresh" && input.summaryText) {
    parts.push(input.summaryText);
  }

  // Role tags as descriptive phrase
  if (input.roleTags.length > 0) {
    parts.push(`This is a ${input.roleTags.join(", ")} component.`);
  }

  // Invariants as prose
  if (input.invariants.length > 0) {
    parts.push(`Invariants: ${input.invariants.join("; ")}.`);
  }

  // Side effects as prose
  if (input.sideEffects.length > 0) {
    parts.push(`Side effects: ${input.sideEffects.join("; ")}.`);
  }

  // Related code context (imports and calls as prose, not raw list)
  const relatedContext: string[] = [];
  if (input.imports.length > 0) {
    const importLabels = input.imports.map((i) => i.label);
    relatedContext.push(`imports ${importLabels.join(", ")}`);
  }
  if (input.calls.length > 0) {
    const callLabels = input.calls.map((c) => c.label);
    relatedContext.push(`calls ${callLabels.join(", ")}`);
  }
  if (relatedContext.length > 0) {
    parts.push(`This symbol ${relatedContext.join(" and ")}.`);
  }

  // Search terms as context
  if (input.searchTerms.length > 0) {
    parts.push(`Related terms: ${input.searchTerms.join(", ")}.`);
  }

  return parts.join(" ");
}

/**
 * Build a minimal fallback payload for unknown models.
 *
 * This produces a simple text with just the essential symbol identity,
 * used only when an unsupported model reaches the dispatcher.
 */
function buildFallbackEmbeddingText(
  input: PreparedSymbolEmbeddingInput,
): string {
  const parts: string[] = [];
  parts.push(`${input.symbol.name} (${input.symbol.kind})`);
  if (input.signatureText) {
    parts.push(input.signatureText);
  }
  if (input.summaryFreshness === "fresh" && input.summaryText) {
    parts.push(input.summaryText);
  }
  return parts.join("\n");
}

/**
 * Model-aware dispatcher that selects the appropriate payload builder.
 *
 * Routes to:
 * - Jina builder for "jina-embeddings-v2-base-code"
 * - Nomic builder for "nomic-embed-text-v1.5"
 * - Minimal fallback for any other model
 *
 * The dispatched text should be passed through applyDocumentPrefix() after
 * construction to add any model-specific prefixes.
 */
export function buildSymbolEmbeddingText(
  model: string,
  input: PreparedSymbolEmbeddingInput,
): string {
  switch (model) {
    case "jina-embeddings-v2-base-code":
      return buildJinaSymbolEmbeddingText(input);
    case "nomic-embed-text-v1.5":
      return buildNomicSymbolEmbeddingText(input);
    default:
      return buildFallbackEmbeddingText(input);
  }
}
