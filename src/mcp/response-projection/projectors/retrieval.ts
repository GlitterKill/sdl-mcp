import {
  quoteIfNeeded,
  splitCsvRow,
  unquote,
} from "../../wire/packed/format.js";
import { parseTablesScalar } from "../../wire/packed/schema.js";
import {
  buildHotPathPagingRecovery,
} from "../recovery.js";
import type {
  ModelProjectionInput,
  ModelValueProjectionDelegate,
} from "../types.js";

const DEP_LIMIT = 8;
const RETRIEVE_ACTION_BY_OP: Readonly<Record<string, string>> = {
  symbolSearch: "symbol.search",
  symbolGetCard: "symbol.getCard",
  sliceBuild: "slice.build",
  codeSkeleton: "code.getSkeleton",
  codeHotPath: "code.getHotPath",
  codeNeedWindow: "code.needWindow",
  responseGet: "response.get",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function copyPresent(
  source: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const value = source[key];
    if (
      value !== undefined
      && value !== false
      && (!Array.isArray(value) || value.length > 0)
    ) {
      result[key] = value;
    }
  }
  return result;
}

function compactDeps(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const result: Record<string, unknown> = {};
  for (const key of ["imports", "calls"] as const) {
    const items = value[key];
    if (!Array.isArray(items) || items.length === 0) continue;
    result[key] = items.slice(0, DEP_LIMIT);
    const priorOmitted = value[`${key}Omitted`];
    const omitted = items.length - Math.min(items.length, DEP_LIMIT)
      + (
        typeof priorOmitted === "number" && priorOmitted > 0
          ? priorOmitted
          : 0
      );
    if (omitted > 0) result[`${key}Omitted`] = omitted;
  }
  if (typeof value.callsNote === "string" && value.callsNote.length > 0) {
    result.callsNote = value.callsNote;
  }
  return result;
}

function compactCard(
  value: unknown,
  includeProcesses = false,
  full = false,
): unknown {
  if (!isRecord(value)) return value;
  if (value.unchanged === true || isRecord(value.ref)) return { ...value };
  const result = copyPresent(value, [
    "symbolId", "shortId", "file", "range", "kind", "name", "exported",
    "visibility", "signature", "summary", "summaryProvenance", "invariants",
    "sideEffects", "testCase", "detailLevel",
  ]);
  if (
    typeof result.visibility !== "string"
    || !["public", "protected", "private", "exported", "internal"].includes(
      result.visibility,
    )
  ) {
    delete result.visibility;
  }
  if (includeProcesses && Array.isArray(value.processes)) {
    result.processes = value.processes;
  }
  if (full && isRecord(value.cluster)) result.cluster = value.cluster;
  const deps = full ? value.deps : compactDeps(value.deps);
  if (isRecord(deps) && Object.keys(deps).length > 0) result.deps = deps;
  if (isRecord(value.version) && value.version.ledgerVersion !== undefined) {
    result.version = { ledgerVersion: value.version.ledgerVersion };
  }
  return result;
}

function compactCards(
  value: Record<string, unknown>,
  includeProcesses: boolean,
  full: boolean,
): unknown {
  const result: Record<string, unknown> = {};
  if (value.card !== undefined) {
    result.card = compactCard(value.card, includeProcesses, full);
  } else if (typeof value.symbolId === "string") {
    return compactCard(value, includeProcesses, full);
  }
  if (Array.isArray(value.cards)) {
    result.cards = value.cards.map((card) => compactCard(card, includeProcesses, full));
  }
  Object.assign(result, copyPresent(value, [
    "partial", "succeeded", "failed", "failures", "truncation",
  ]));
  return result;
}

function isPackedDefault(value: string, type: string): boolean {
  if (type === "int" || type === "float") return value === "0";
  if (type === "bool") return value === "0" || value === "false";
  return value === "";
}

interface CompactPackedTable {
  tag: string;
  table: string;
  rawSpec: string;
  columns: string[];
  types: string[];
  indexes: number[];
  rows: string[][];
}

function hasValidPackedRowQuotes(line: string): boolean {
  let inQuotes = false;
  let atFieldStart = true;
  let closedQuotedField = false;
  for (let index = 0; index < line.length; index++) {
    const character = line[index]!;
    if (inQuotes) {
      if (character !== '"') continue;
      if (line[index + 1] === '"') {
        index++;
        continue;
      }
      inQuotes = false;
      closedQuotedField = true;
      continue;
    }
    if (closedQuotedField) {
      if (character !== ",") return false;
      closedQuotedField = false;
      atFieldStart = true;
      continue;
    }
    if (character === ",") {
      atFieldStart = true;
      continue;
    }
    if (character === '"') {
      if (!atFieldStart) return false;
      inQuotes = true;
    }
    atFieldStart = false;
  }
  return !inQuotes;
}

/** Elide only columns whose encoded value is the type default in every row. */
function compactPackedDefaults(payload: string): string {
  if (!payload.startsWith("#PACKED/1")) return payload;
  const lines = payload.split("\n");
  const scalarIndex = lines.findIndex((line) => line.includes("__tables="));
  const match = scalarIndex >= 0
    ? /__tables=([^ ]+)/.exec(lines[scalarIndex]!)
    : undefined;
  if (!match) return payload;

  const rawSpecs = match[1]!.split(",");
  const parsedSpecs = parseTablesScalar(match[1]!);
  if (rawSpecs.length === 0 || parsedSpecs.length !== rawSpecs.length) {
    return payload;
  }

  const tables: CompactPackedTable[] = [];
  const byTag = new Map<string, CompactPackedTable>();
  for (let index = 0; index < rawSpecs.length; index++) {
    const rawSpec = rawSpecs[index]!;
    const parts = rawSpec.split(":");
    const parsed = parsedSpecs[index];
    if (parts.length !== 4 || !parsed) return payload;
    const [tag, table, columnText, typeText] = parts;
    const columns = columnText?.split("|") ?? [];
    const types = typeText?.split("|") ?? [];
    if (
      !tag
      || !table
      || columns.length === 0
      || columns.some((column) => column.length === 0)
      || columns.length !== types.length
      || types.some((type) =>
        !["str", "int", "float", "bool"].includes(type)
      )
      || parsed.tag !== tag
      || parsed.key !== table
      || parsed.columns.length !== columns.length
      || byTag.has(tag)
    ) {
      return payload;
    }
    const compactTable: CompactPackedTable = {
      tag,
      table,
      rawSpec,
      columns,
      types,
      indexes: [],
      rows: [],
    };
    tables.push(compactTable);
    byTag.set(tag, compactTable);
  }

  for (let index = scalarIndex + 1; index < lines.length; index++) {
    const line = lines[index]!;
    if (line.length === 0) continue;
    if (!hasValidPackedRowQuotes(line)) return payload;
    const row = splitCsvRow(line);
    const table = byTag.get(unquote(row[0] ?? ""));
    if (!table || row.length !== table.columns.length + 1) return payload;
    table.indexes.push(index);
    table.rows.push(row);
  }

  const nextLines = [...lines];
  let scalarLine = lines[scalarIndex]!;
  for (const table of tables) {
    if (table.rows.length === 0) continue;
    const keep = table.columns.map((column, index) =>
      column === "symbolId"
      || column === "shortId"
      || table.rows.some((row) =>
        !isPackedDefault(unquote(row[index + 1] ?? ""), table.types[index]!)
      ),
    );
    if (keep.every(Boolean)) continue;
    const nextColumns = table.columns.filter((_column, index) => keep[index]);
    const nextTypes = table.types.filter((_type, index) => keep[index]);
    scalarLine = scalarLine.replace(
      table.rawSpec,
      `${table.tag}:${table.table}:${nextColumns.join("|")}:${nextTypes.join("|")}`,
    );
    table.indexes.forEach((lineIndex, rowIndex) => {
      nextLines[lineIndex] = [
        table.tag,
        ...table.rows[rowIndex]!.slice(1)
          .filter((_field, index) => keep[index])
          .map((field) => quoteIfNeeded(unquote(field))),
      ].join(",");
    });
  }
  nextLines[scalarIndex] = scalarLine;
  return nextLines.join("\n");
}

function compactSearch(value: Record<string, unknown>): unknown {
  const result: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) {
    if (
      key === "structuredContent"
      || key === "retrievalEvidence"
      || key === "diagnostics"
    ) continue;
    result[key] = typeof field === "string"
      ? compactPackedDefaults(field)
      : field;
  }
  return result;
}

function compactCode(
  value: Record<string, unknown>,
  input: ModelProjectionInput,
  action: string,
): unknown {
  const result = copyPresent(value, [
    "approved", "symbolId", "file", "range", "code", "skeleton", "excerpt",
    "ref", "unchanged", "changedSincePrior", "truncated", "truncation",
    "status", "contentKind", "whyDenied", "nextBestAction",
    "requiredFieldsForNext", "nextAction", "matchedIdentifiers",
    "missedIdentifiers", "missedIdentifierHint", "actualRange",
  ]);
  // The public hot-path contract requires this field even when nothing matched.
  if (action === "code.getHotPath" && Array.isArray(value.matchedIdentifiers)) {
    result.matchedIdentifiers = value.matchedIdentifiers;
  }
  if (input.options.includeDiagnostics) {
    Object.assign(result, copyPresent(value, [
      "estimatedTokens", "matchedLineNumbers",
    ]));
  }
  if (
    action === "code.getHotPath"
    && value.truncated === true
    && result.nextAction === undefined
  ) {
    const recovery = buildHotPathPagingRecovery(
      input.context.requestArgs,
      value,
    );
    if (recovery) result.nextAction = recovery;
  }
  return result;
}

function primaryAction(value: Record<string, unknown>): unknown {
  if (value.nextAction !== undefined) return value.nextAction;
  return Array.isArray(value.nextActions) ? value.nextActions[0] : undefined;
}

function compactItem(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const result: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) {
    if (
      key === "rank" || key === "score" || key === "relevance"
      || key === "telemetry" || (key === "summary" && field === "")
      || (Array.isArray(field) && field.length === 0)
    ) continue;
    result[key] = field;
  }
  return result;
}

function compactEvidence(
  value: unknown,
  input: ModelProjectionInput,
): unknown {
  if (!isRecord(value)) return value;
  const result = copyPresent(value, ["symbolId", "rung", "path"]);
  if (input.options.includeDiagnostics) {
    Object.assign(result, copyPresent(value, ["rank", "tier", "lanes"]));
  }

  // Context evidence embeds card/code payloads, so project that nested owner too.
  const content = value.rung === "card"
    ? compactCard(
      value.content,
      false,
      input.options.detail === "full",
    )
    : isRecord(value.content)
    ? compactCode(value.content, input, "context")
    : value.content;
  if (
    content !== undefined
    && (!isRecord(content) || Object.keys(content).length > 0)
  ) {
    result.content = content;
  }
  return result;
}

function compactSlice(value: Record<string, unknown>): unknown {
  const action = primaryAction(value);
  if (action !== undefined) return { nextAction: action };
  const result: Record<string, unknown> = {};
  if (typeof value.sliceHandle === "string") {
    result.sliceHandle = value.sliceHandle;
  }
  const source = isRecord(value.slice) ? value.slice : value;
  const slice: Record<string, unknown> = {};
  if (Array.isArray(source.startSymbols)) {
    slice.startSymbols = source.startSymbols;
  }
  if (Array.isArray(source.cards)) {
    slice.cards = source.cards.slice(0, 12).map(compactItem);
    if (source.cards.length > 12) slice.cardsOmitted = source.cards.length - 12;
  }
  if (Array.isArray(source.edges)) {
    slice.edges = source.edges.slice(0, 16).map(compactItem);
    if (source.edges.length > 16) slice.edgesOmitted = source.edges.length - 16;
  }
  for (const key of ["legend", "visibilityLegend"]) {
    if (isRecord(source[key]) && Object.keys(source[key]).length > 0) {
      slice[key] = source[key];
    }
  }
  if (Object.keys(slice).length > 0) result.slice = slice;
  return result;
}

function compactSpillover(value: Record<string, unknown>): unknown {
  if (
    typeof value.spilloverHandle !== "string"
    || typeof value.hasMore !== "boolean"
    || !Array.isArray(value.symbols)
  ) {
    return value;
  }
  const result: Record<string, unknown> = {
    spilloverHandle: value.spilloverHandle,
  };
  if (typeof value.cursor === "string") result.cursor = value.cursor;
  result.hasMore = value.hasMore;
  result.symbols = value.symbols.map((symbol) => compactCard(symbol, false));
  return result;
}

function compactRetrieval(
  value: unknown,
  input: ModelProjectionInput,
): unknown {
  if (!isRecord(value)) return undefined;
  const lanes = Array.isArray(value.lanes) ? value.lanes : [];
  const healthy = value.level === "hybrid"
    && lanes.every((lane) => isRecord(lane) && lane.available === true);
  if (healthy && !input.options.includeDiagnostics) return undefined;

  const result: Record<string, unknown> = {};
  if (value.level !== undefined) result.level = value.level;
  if (input.options.includeDiagnostics) {
    result.lanes = lanes.filter(isRecord).map((lane) => {
      const projected: Record<string, unknown> = {};
      if (typeof lane.id === "string") projected.id = lane.id;
      if (typeof lane.available === "boolean") projected.available = lane.available;
      if (typeof lane.coveragePermille === "number") {
        projected.coveragePermille = lane.coveragePermille;
      }
      return projected;
    });
    Object.assign(result, copyPresent(value, [
      "fusionLatencyMs", "diagnosticTimings",
    ]));
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function compactOmitted(value: unknown): unknown {
  if (!isRecord(value) || typeof value.total !== "number" || value.total <= 0) {
    return undefined;
  }
  const result: Record<string, unknown> = { total: value.total };
  if (isRecord(value.byReason)) {
    const byReason = Object.fromEntries(
      Object.entries(value.byReason).filter(
        ([, count]) => typeof count === "number" && count > 0,
      ),
    );
    if (Object.keys(byReason).length > 0) result.byReason = byReason;
  }
  return result;
}

function compactContext(
  value: Record<string, unknown>,
  input: ModelProjectionInput,
): unknown {
  const result = copyPresent(value, [
    "status", "taskType", "notModified",
  ]);
  const retrieval = compactRetrieval(value.retrieval, input);
  if (retrieval !== undefined) result.retrieval = retrieval;
  if (Array.isArray(value.evidence) && value.evidence.length > 0) {
    result.evidence = value.evidence.map((item) =>
      compactEvidence(item, input)
    );
  }
  if (Array.isArray(value.edges) && value.edges.length > 0) {
    result.edges = value.edges.map((edge) => {
      if (!isRecord(edge)) return edge;
      const projected = copyPresent(edge, ["from", "to", "kind"]);
      if (input.options.includeDiagnostics) {
        Object.assign(projected, copyPresent(edge, ["confidencePermille"]));
      }
      return projected;
    });
  }
  const omitted = compactOmitted(value.omitted);
  if (omitted !== undefined) result.omitted = omitted;

  let action = primaryAction(value);
  if (action === undefined && isRecord(value.omitted)) {
    const highestRanked = value.omitted.highestRanked;
    const first = Array.isArray(highestRanked) ? highestRanked[0] : undefined;
    if (isRecord(first)) action = first.action;
  }
  if (action !== undefined) result.nextAction = action;
  if (input.options.includeDiagnostics) {
    Object.assign(result, copyPresent(value, [
      "sessionDelta", "diagnosticTimings",
    ]));
  }
  Object.assign(result, copyPresent(value, [
    "handle", "action", "responseMode", "kind", "metadata",
  ]));
  return result;
}

function actionForInput(input: ModelProjectionInput): string {
  const action = input.action.startsWith("sdl.")
    ? input.action.slice(4)
    : input.action;
  if (action !== "retrieve") return action;
  const op = input.context.requestArgs.op;
  return typeof op === "string" ? RETRIEVE_ACTION_BY_OP[op] ?? action : action;
}

function projectCompact(
  input: ModelProjectionInput,
  value: Record<string, unknown>,
): unknown {
  const action = actionForInput(input);
  if (action === "symbol.getCard") {
    return compactCards(
      value,
      input.context.requestArgs.includeProcesses === true,
      input.options.detail === "full",
    );
  }
  if (action === "symbol.search") return compactSearch(value);
  if (
    action === "code.needWindow"
    || action === "code.getSkeleton"
    || action === "code.getHotPath"
  ) return compactCode(value, input, action);
  if (action === "slice.build") return compactSlice(value);
  if (action === "slice.spillover.get") return compactSpillover(value);
  if (action === "context") return compactContext(value, input);
  return value;
}

function projectSliceRefresh(
  value: Record<string, unknown>,
  includeDiagnostics: boolean,
): Record<string, unknown> {
  if (includeDiagnostics || !isRecord(value.lease)) return value;
  const lease = { ...value.lease };
  delete lease.expiresAt;
  return { ...value, lease };
}

/** Keep canonical retrieval data untouched and select only final model presentation. */
export function projectRetrievalValue(
  input: ModelProjectionInput,
  projectCompatibilityValue: ModelValueProjectionDelegate,
): unknown {
  const action = actionForInput(input);
  const compatibility = projectCompatibilityValue(
    action === "response.get" ? { ...input, action: "response.get" } : input,
  );
  const canonical = input.canonicalResult;
  if (!isRecord(canonical)) return compatibility;
  if (isRecord(canonical.error)) {
    const code = canonical.error.code;
    return typeof code === "string"
      && (/GRAPH.*UNAVAILABLE/.test(code) || /BLOCKED/.test(code))
      ? canonical
      : compatibility;
  }
  if (action === "slice.refresh" && isRecord(compatibility)) {
    return projectSliceRefresh(compatibility, input.options.includeDiagnostics);
  }
  if (![
    "symbol.getCard",
    "symbol.search",
    "code.needWindow",
    "code.getSkeleton",
    "code.getHotPath",
    "slice.build",
    "slice.spillover.get",
    "context",
  ].includes(action)) {
    return compatibility;
  }
  return projectCompact(input, canonical);
}
