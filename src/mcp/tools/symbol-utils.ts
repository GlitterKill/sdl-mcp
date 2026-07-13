import type { SymbolRow as LegacySymbolRow } from "../../db/schema.js";
import type { SymbolRow } from "../../db/ladybug-queries.js";
import {
  isMetadataProseTemplate,
  isNameOnlySummary,
} from "../../indexer/summaries.js";

export function toLegacySymbolRow(symbol: SymbolRow): LegacySymbolRow {
  return {
    symbol_id: symbol.symbolId,
    repo_id: symbol.repoId,
    file_id: 0,
    kind: symbol.kind as LegacySymbolRow["kind"],
    name: symbol.name,
    exported: symbol.exported ? 1 : 0,
    visibility: symbol.visibility as LegacySymbolRow["visibility"],
    language: symbol.language,
    range_start_line: symbol.rangeStartLine,
    range_start_col: symbol.rangeStartCol,
    range_end_line: symbol.rangeEndLine,
    range_end_col: symbol.rangeEndCol,
    ast_fingerprint: symbol.astFingerprint,
    signature_json: symbol.signatureJson,
    summary: symbol.summary,
    invariants_json: symbol.invariantsJson,
    side_effects_json: symbol.sideEffectsJson,
    updated_at: symbol.updatedAt,
  };
}


interface WireRangeInput {
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
}

interface WireDepsInput {
  imports?: unknown[] | null;
  calls?: unknown[] | null;
  callsNote?: unknown;
}

interface CompactCardForWireOptions {
  compactRanges?: boolean;
}

interface WireCardInput {
  symbolId?: unknown;
  repoId?: unknown;
  file?: unknown;
  range?: WireRangeInput | unknown;
  kind?: unknown;
  name?: unknown;
  exported?: unknown;
  visibility?: unknown;
  signature?: unknown;
  summary?: unknown;
  summaryProvenance?: unknown;
  invariants?: unknown;
  sideEffects?: unknown;
  cluster?: unknown;
  processes?: unknown;
  callResolution?: unknown;
  deps?: WireDepsInput | null;
  metrics?: unknown;
  detailLevel?: unknown;
  etag?: unknown;
  version?: unknown;
  truncated?: unknown;
}

/** Canonical insertion order for every model-visible symbol card field. */
export const CARD_WIRE_FIELD_ORDER = [
  "symbolId",
  "repoId",
  "file",
  "range",
  "kind",
  "name",
  "exported",
  "visibility",
  "signature",
  "summary",
  "summaryProvenance",
  "invariants",
  "sideEffects",
  "cluster",
  "processes",
  "callResolution",
  "deps",
  "metrics",
  "detailLevel",
  "etag",
  "version",
  "truncated",
] as const;

type CardWireField = (typeof CARD_WIRE_FIELD_ORDER)[number];

function isEmptyObject(value: unknown): value is Record<string, never> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  );
}

function shouldOmitWireField(value: unknown): boolean {
  return (
    value == null ||
    (Array.isArray(value) && value.length === 0) ||
    isEmptyObject(value)
  );
}

function isWireRange(value: unknown): value is WireRangeInput {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const range = value as Partial<Record<keyof WireRangeInput, unknown>>;
  return (
    typeof range.startLine === "number" &&
    typeof range.startCol === "number" &&
    typeof range.endLine === "number" &&
    typeof range.endCol === "number"
  );
}

export function compactRange(range: WireRangeInput): string {
  if (range.startCol === 0 && range.endCol === 0) {
    return `${range.startLine}-${range.endLine}`;
  }
  return `${range.startLine}:${range.startCol}-${range.endLine}:${range.endCol}`;
}

export function cardSummaryForWire(
  summary: unknown,
  symbolName: unknown,
): string | undefined {
  if (typeof summary !== "string") {
    return undefined;
  }
  const trimmed = summary.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  if (
    typeof symbolName === "string" &&
    (isNameOnlySummary(trimmed, symbolName) ||
      isMetadataProseTemplate(trimmed, symbolName))
  ) {
    return undefined;
  }
  return summary;
}


function compactDepsForWire(
  deps: WireDepsInput | null | undefined,
): Record<string, unknown> | undefined {
  const imports = deps?.imports ?? [];
  const calls = deps?.calls ?? [];
  if (imports.length === 0 && calls.length === 0) {
    return undefined;
  }

  const out: Record<string, unknown> = {};
  if (imports.length > 0) out.imports = imports;
  if (calls.length > 0) {
    out.calls = calls;
    if (
      typeof deps?.callsNote === "string" &&
      deps.callsNote.trim().length > 0
    ) {
      out.callsNote = deps.callsNote;
    }
  }
  return out;
}

function addWireField(
  out: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  if (!shouldOmitWireField(value)) {
    out[key] = value;
  }
}

export function compactCardForWire(
  card: WireCardInput,
  opts: CompactCardForWireOptions = {},
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const summary = cardSummaryForWire(card.summary, card.name);
  const values: Record<CardWireField, unknown> = {
    symbolId: card.symbolId,
    repoId: card.repoId,
    file: card.file,
    range:
      opts.compactRanges && isWireRange(card.range)
        ? compactRange(card.range)
        : card.range,
    kind: card.kind,
    name: card.name,
    exported: card.exported,
    visibility: card.visibility,
    signature: card.signature,
    summary,
    summaryProvenance:
      summary === undefined ? undefined : card.summaryProvenance,
    invariants: card.invariants,
    sideEffects: card.sideEffects,
    cluster: card.cluster,
    processes: card.processes,
    callResolution: card.callResolution,
    deps: compactDepsForWire(card.deps),
    metrics: card.metrics,
    detailLevel: card.detailLevel,
    etag: card.etag,
    version: card.version,
    truncated: card.truncated,
  };

  for (const field of CARD_WIRE_FIELD_ORDER) {
    addWireField(out, field, values[field]);
  }

  return out;
}
