import type { Connection } from "kuzu";
import * as ladybugDb from "../db/ladybug-queries.js";
import { hashContent } from "../util/hashing.js";
import { logger } from "../util/logger.js";

const MAX_IMPORT_LABELS = 8;
const MAX_CALL_LABELS = 12;
const MAX_SEARCH_TERMS = 16;
const MAX_SEARCH_TERM_LEN = 32;
const MAX_FALLBACK_LABEL_LEN = 64;
const MIN_CALL_CONFIDENCE = 0.5;
const MIN_IMPORT_CONFIDENCE = 0.5;

export type SummaryFreshness = "fresh" | "stale" | "absent";

export interface GraphLabel {
  label: string;
  confidence: number;
  resolved: boolean;
}

export interface PreparedSymbolEmbeddingInput {
  symbol: ladybugDb.SymbolRow;
  signatureText: string | null;
  relPath: string | null;
  language: string | null;
  roleTags: string[];
  searchTerms: string[];
  invariants: string[];
  sideEffects: string[];
  imports: GraphLabel[];
  calls: GraphLabel[];
  summaryFreshness: SummaryFreshness;
  summaryText: string | null;
}

export interface PrepareSymbolEmbeddingInputsOptions {
  summaryCacheMap?: Map<string, ladybugDb.SummaryCacheRow>;
}

/**
 * Parse a pipe-delimited signature JSON and extract the text field.
 * Intentionally duplicated from embeddings.ts to avoid import cycle:
 * embeddings.ts imports from symbol-embedding-context.ts, so this file
 * cannot import from embeddings.ts. If changing this logic, update both.
 */
function parseSignatureText(signatureJson: string | null): string | null {
  if (!signatureJson) return null;
  try {
    const parsed = JSON.parse(signatureJson) as { text?: string } | string;
    return typeof parsed === "string"
      ? parsed
      : (parsed?.text ?? signatureJson);
  } catch (err) {
    logger.debug(
      "symbol-embedding-context: failed to parse signature JSON, using raw",
      { error: err instanceof Error ? err.message : String(err) },
    );
    return signatureJson;
  }
}

export function parseJsonArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((v): v is string => typeof v === "string" && v.length > 0)
      .map((v) => v.trim())
      .filter((v) => v.length > 0);
  } catch {
    return [];
  }
}

export function deriveSearchTerms(
  searchText: string | null | undefined,
): string[] {
  if (!searchText) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of searchText.split(/\s+/)) {
    const term = raw.toLowerCase().replace(/[^\w$.-]/g, "");
    if (!term || !/\w/.test(term)) continue;
    if (term.length > MAX_SEARCH_TERM_LEN) continue;
    if (seen.has(term)) continue;
    seen.add(term);
    out.push(term);
    if (out.length >= MAX_SEARCH_TERMS) break;
  }
  return out;
}

/**
 * Parse an unresolved edge target symbolId into a human-readable label.
 *
 * Formats produced by the indexer:
 *   - `unresolved:call:<targetName>`                      — unresolved call
 *   - `unresolved:<specifier>:<name>`                     — unresolved import (named)
 *   - `unresolved:<specifier>:* as <namespaceImport>`     — unresolved import (namespace)
 *
 * Returns null when the target cannot be rendered as a stable label.
 */
export function parseUnresolvedTarget(
  targetId: string,
): { kind: "call" | "import"; label: string } | null {
  if (!targetId.startsWith("unresolved:")) return null;

  if (targetId.startsWith("unresolved:call:")) {
    const name = targetId.slice("unresolved:call:".length).trim();
    if (!name) return null;
    return { kind: "call", label: name };
  }

  const rest = targetId.slice("unresolved:".length);
  const lastColon = rest.lastIndexOf(":");
  if (lastColon <= 0 || lastColon === rest.length - 1) return null;

  const specifier = rest.slice(0, lastColon).trim();
  const name = rest.slice(lastColon + 1).trim();
  if (!specifier || !name) return null;

  if (name.startsWith("* as ")) {
    const ns = name.slice(5).trim();
    if (!ns) return null;
    return { kind: "import", label: `${ns} (* from ${specifier})` };
  }

  return { kind: "import", label: `${name} (from ${specifier})` };
}

export function fallbackLabel(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  const lastSlash = trimmed.lastIndexOf("/");
  const tail = lastSlash >= 0 ? trimmed.slice(lastSlash + 1) : trimmed;
  const picked = tail.length > 0 ? tail : trimmed;
  return picked.length > MAX_FALLBACK_LABEL_LEN
    ? picked.slice(0, MAX_FALLBACK_LABEL_LEN)
    : picked;
}

export function normalizeAndCap(
  candidates: GraphLabel[],
  cap: number,
  sortMode: "alpha" | "confidenceThenAlpha",
): GraphLabel[] {
  const byKey = new Map<string, GraphLabel>();
  for (const c of candidates) {
    const key = c.label.toLowerCase();
    if (!key) continue;
    const existing = byKey.get(key);
    if (!existing || c.confidence > existing.confidence) {
      byKey.set(key, c);
    }
  }
  const arr = [...byKey.values()];
  if (sortMode === "alpha") {
    arr.sort((a, b) => a.label.localeCompare(b.label));
  } else {
    arr.sort((a, b) => {
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      return a.label.localeCompare(b.label);
    });
  }
  return arr.slice(0, cap);
}

export function evaluateSummaryFreshness(
  symbol: ladybugDb.SymbolRow,
  signatureText: string | null,
  cached: ladybugDb.SummaryCacheRow | undefined,
): { freshness: SummaryFreshness; summaryText: string | null } {
  if (!cached || cached.provider === "mock") {
    return { freshness: "absent", summaryText: null };
  }
  const expected = hashContent(
    [
      symbol.name,
      symbol.kind ?? "",
      signatureText ?? "",
      symbol.astFingerprint ?? "",
      cached.provider,
      cached.model,
    ].join("|"),
  );
  if (expected === cached.cardHash) {
    return { freshness: "fresh", summaryText: cached.summary };
  }
  return { freshness: "stale", summaryText: null };
}

export function buildGraphLabels(
  edges: ladybugDb.EdgeRow[],
  resolvedTargets: Map<string, ladybugDb.SymbolBasicInfo>,
): { imports: GraphLabel[]; calls: GraphLabel[] } {
  const importsCandidates: GraphLabel[] = [];
  const callsCandidates: GraphLabel[] = [];

  for (const edge of edges) {
    const targetId = edge.toSymbolId;
    if (!targetId) continue;

    // Skip low-confidence import edges (call edges already filtered at DB level)
    if (edge.edgeType === "import" && edge.confidence < MIN_IMPORT_CONFIDENCE) {
      continue;
    }

    if (targetId.startsWith("unresolved:")) {
      const parsed = parseUnresolvedTarget(targetId);
      if (parsed) {
        const bucket =
          parsed.kind === "call" ? callsCandidates : importsCandidates;
        bucket.push({
          label: parsed.label,
          confidence: edge.confidence,
          resolved: false,
        });
        continue;
      }
      const fallback = fallbackLabel(targetId.slice("unresolved:".length));
      if (!fallback) continue;
      const bucket =
        edge.edgeType === "call" ? callsCandidates : importsCandidates;
      bucket.push({
        label: fallback,
        confidence: edge.confidence,
        resolved: false,
      });
      continue;
    }

    const resolved = resolvedTargets.get(targetId);
    if (!resolved) continue;
    const label = resolved.kind
      ? `${resolved.name} (${resolved.kind})`
      : resolved.name;
    if (edge.edgeType === "call") {
      callsCandidates.push({
        label,
        confidence: edge.confidence,
        resolved: true,
      });
    } else if (edge.edgeType === "import") {
      importsCandidates.push({
        label,
        confidence: edge.confidence,
        resolved: true,
      });
    }
  }

  return {
    imports: normalizeAndCap(importsCandidates, MAX_IMPORT_LABELS, "alpha"),
    calls: normalizeAndCap(
      callsCandidates,
      MAX_CALL_LABELS,
      "confidenceThenAlpha",
    ),
  };
}

/**
 * Batch-prepare per-symbol embedding context. Read-only: performs at most one
 * call each to `getFilesByIds`, `getEdgesFromSymbols`, `getSymbolsByIdsLite`,
 * and (optionally) `getSummaryCaches`.
 *
 * Callers may pass a pre-loaded `summaryCacheMap` to avoid a second summary
 * cache read when they already hold one for another purpose.
 */
export async function prepareSymbolEmbeddingInputs(
  conn: Connection,
  symbols: ladybugDb.SymbolRow[],
  options: PrepareSymbolEmbeddingInputsOptions = {},
): Promise<PreparedSymbolEmbeddingInput[]> {
  if (symbols.length === 0) return [];

  const symbolIds = symbols.map((s) => s.symbolId);

  const fileIds = [
    ...new Set(symbols.map((s) => s.fileId).filter((v): v is string => !!v)),
  ];

  const [filesMap, edgesMap, summaryCacheMap] = await Promise.all([
    ladybugDb.getFilesByIds(conn, fileIds),
    ladybugDb.getEdgesFromSymbols(conn, symbolIds, {
      minCallConfidence: MIN_CALL_CONFIDENCE,
    }),
    options.summaryCacheMap
      ? Promise.resolve(options.summaryCacheMap)
      : ladybugDb.getSummaryCaches(conn, symbolIds),
  ]);

  const resolvedTargetIds = new Set<string>();
  for (const edgeList of edgesMap.values()) {
    for (const edge of edgeList) {
      if (!edge.toSymbolId.startsWith("unresolved:")) {
        resolvedTargetIds.add(edge.toSymbolId);
      }
    }
  }
  const resolvedTargets =
    resolvedTargetIds.size > 0
      ? await ladybugDb.getSymbolsByIdsLite(conn, [...resolvedTargetIds])
      : new Map<string, ladybugDb.SymbolBasicInfo>();

  const prepared: PreparedSymbolEmbeddingInput[] = [];
  for (const symbol of symbols) {
    const signatureText = parseSignatureText(symbol.signatureJson);
    const file = symbol.fileId ? filesMap.get(symbol.fileId) : undefined;
    const edges = edgesMap.get(symbol.symbolId) ?? [];
    const { imports, calls } = buildGraphLabels(edges, resolvedTargets);
    const { freshness, summaryText } = evaluateSummaryFreshness(
      symbol,
      signatureText,
      summaryCacheMap.get(symbol.symbolId),
    );

    prepared.push({
      symbol,
      signatureText,
      relPath: file?.relPath ?? null,
      language: file?.language ?? null,
      roleTags: parseJsonArray(symbol.roleTagsJson ?? null),
      searchTerms: deriveSearchTerms(symbol.searchText ?? null),
      invariants: parseJsonArray(symbol.invariantsJson),
      sideEffects: parseJsonArray(symbol.sideEffectsJson),
      imports,
      calls,
      summaryFreshness: freshness,
      summaryText,
    });
  }

  return prepared;
}
