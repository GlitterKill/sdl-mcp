/**
 * Schema-driven encoder/decoder. Per-tool encoders register a TableSpec[]
 * here; this module turns objects into table rows + scalars and back again.
 *
 * The decoder is *schema-free* on the read side (sees __tables/__stypes in
 * the payload) — schema.ts only powers the *encoder* path.
 */

import {
  Legends,
  assemble,
  parseHeader,
  parseScalars,
  splitCsvRow,
  unquote,
  writeHeader,
  writeScalars,
  writeTableRows,
  type PackedSections,
} from "./format.js";
import type { ScalarTypeMap, TableSpec } from "./types.js";
import { PackedDecodeError } from "./types.js";

export interface SchemaEncodeInput {
  toolName: string;
  encoderId: string;
  scalars: Record<string, unknown>;
  scalarTypes?: ScalarTypeMap;
  tables: { spec: TableSpec; rows: Array<Record<string, unknown>> }[];
  legendCandidates?: string[];
}

function inferScalarType(
  value: unknown,
): "str" | "int" | "float" | "bool" | "json" {
  if (typeof value === "boolean") return "bool";
  if (typeof value === "number")
    return Number.isInteger(value) ? "int" : "float";
  if (value === null || typeof value === "undefined") return "str";
  if (typeof value === "object") return "json";
  return "str";
}

function scalarToString(
  value: unknown,
  type: "str" | "int" | "float" | "bool" | "json",
): string {
  if (value === null || typeof value === "undefined") return "";
  if (type === "bool") return value ? "T" : "F";
  if (type === "int" || type === "float") return String(value);
  if (type === "json") return JSON.stringify(value);
  return String(value);
}

/**
 * Build legend prefixes from candidate path-like strings. Common longest
 * prefix per directory wins; <2-occurrence prefixes are dropped (header
 * overhead would dominate).
 */
function buildLegends(candidates: string[]): Legends {
  const legends = new Legends();
  if (candidates.length === 0) return legends;
  const counts = new Map<string, number>();
  for (const path of candidates) {
    const norm = path.replace(/\\/g, "/");
    const lastSlash = norm.lastIndexOf("/");
    if (lastSlash < 1) continue;
    const prefix = norm.slice(0, lastSlash + 1);
    counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
  }
  const sorted = Array.from(counts.entries())
    .filter(([, c]) => c >= 2)
    .sort((a, b) => b[1] * b[0].length - a[1] * a[0].length);
  for (const [prefix] of sorted.slice(0, 16)) {
    legends.add(prefix);
  }
  return legends;
}

function buildTablesScalar(specs: TableSpec[]): string {
  return specs
    .map((spec) => {
      const cols = spec.columns.map((c) => c.name).join("|");
      const types = spec.columns.map((c) => c.type).join("|");
      return `${spec.tag}:${spec.key}:${cols}:${types}`;
    })
    .join(",");
}

function buildStypesScalar(types: ScalarTypeMap): string {
  return Object.entries(types)
    .map(([k, t]) => `${k}:${t}`)
    .join("|");
}

export function encodeSchemaDriven(input: SchemaEncodeInput): string {
  const legends = buildLegends(input.legendCandidates ?? []);

  const scalarTypes: ScalarTypeMap = { ...(input.scalarTypes ?? {}) };
  const reservedScalars: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.scalars)) {
    if (k === "__tables" || k === "__stypes") continue;
    if (!scalarTypes[k]) scalarTypes[k] = inferScalarType(v);
  }

  const renderedScalars: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.scalars)) {
    const t = scalarTypes[k] ?? "str";
    if (t === "json") {
      renderedScalars[`__json.${k}`] = scalarToString(v, "json");
    } else {
      renderedScalars[k] = scalarToString(v, t);
    }
  }

  const specs = input.tables.map((t) => t.spec);
  if (specs.length > 0) {
    reservedScalars.__tables = buildTablesScalar(specs);
  }
  if (Object.keys(scalarTypes).length > 0) {
    reservedScalars.__stypes = buildStypesScalar(scalarTypes);
  }

  const allScalars = { ...renderedScalars, ...reservedScalars };

  const tableSections: string[] = [];
  for (const { spec, rows } of input.tables) {
    if (rows.length === 0) continue;
    const internCols = new Set<number>();
    spec.columns.forEach((c, i) => {
      if (c.intern) internCols.add(i);
    });
    const tableRows = rows.map((row) => ({
      values: spec.columns.map((c) => {
        const raw = row[c.name];
        if (raw === undefined || raw === null) return null;
        if (c.type === "bool") return Boolean(raw);
        if (c.type === "int") return Number(raw);
        if (c.type === "float") return Number(raw);
        if (typeof raw === "object") return JSON.stringify(raw);
        return String(raw);
      }),
    }));
    tableSections.push(
      writeTableRows(spec.tag, tableRows, legends, internCols),
    );
  }

  return assemble({
    header: writeHeader(input.toolName, input.encoderId),
    legend: legends.render(),
    scalars: writeScalars(allScalars),
    tables: tableSections.join("\n\n"),
  });
}

export interface SchemaDecodedPayload {
  toolName: string;
  encoderId: string;
  scalars: Record<string, unknown>;
  tables: Record<string, Array<Record<string, unknown>>>;
}

/** Parse the `__tables` scalar back into TableSpec[]. */
export function parseTablesScalar(raw: string): TableSpec[] {
  if (!raw) return [];
  const specs: TableSpec[] = [];
  const segments: string[] = [];
  let depth = 0;
  let buf = "";
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    if (ch === "," && depth === 0) {
      segments.push(buf);
      buf = "";
    } else buf += ch;
  }
  if (buf) segments.push(buf);
  for (const seg of segments) {
    const parts = seg.split(":");
    if (parts.length < 4) continue;
    const tag = parts[0];
    const key = parts[1];
    const cols = parts[2].split("|");
    const types = parts[3].split("|");
    specs.push({
      tag,
      key,
      columns: cols.map((name, i) => ({
        name: decodeColumnName(name),
        type: (types[i] ?? "str") as "str" | "int" | "float" | "bool",
      })),
    });
  }
  return specs;
}

function decodeColumnName(name: string): string {
  return name.replace(/%([0-9A-Fa-f]{2})/g, (_, h) =>
    String.fromCharCode(parseInt(h, 16)),
  );
}

export function parseStypesScalar(raw: string): ScalarTypeMap {
  if (!raw) return {};
  const out: ScalarTypeMap = {};
  for (const seg of raw.split("|")) {
    const colon = seg.indexOf(":");
    if (colon < 0) continue;
    const k = seg.slice(0, colon);
    const t = seg.slice(colon + 1) as ScalarTypeMap[string];
    out[k] = t;
  }
  return out;
}

function castScalar(
  value: string,
  type: "str" | "int" | "float" | "bool" | "json",
): unknown {
  if (type === "bool") return value === "T";
  if (type === "int") {
    const n = parseInt(value, 10);
    return Number.isFinite(n) ? n : 0;
  }
  if (type === "float") {
    const n = parseFloat(value);
    return Number.isFinite(n) ? n : 0;
  }
  if (type === "json") {
    if (!value) return null;
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  return value;
}

export function decodeSchemaDriven(
  sections: PackedSections,
): SchemaDecodedPayload {
  const header = parseHeader(sections.header);
  const legends = new Legends();
  legends.fromRendered(sections.legend);

  const rawScalars = parseScalars(sections.scalars);
  const tablesSpec = parseTablesScalar(rawScalars.__tables ?? "");
  const stypes = parseStypesScalar(rawScalars.__stypes ?? "");

  const scalars: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rawScalars)) {
    if (k === "__tables" || k === "__stypes") continue;
    if (k.startsWith("__json.")) {
      const realKey = k.slice("__json.".length);
      scalars[realKey] = castScalar(v, "json");
      continue;
    }
    const t = stypes[k] ?? "str";
    scalars[k] = castScalar(v, t);
  }

  const tables: Record<string, Array<Record<string, unknown>>> = {};
  if (sections.tables.trim()) {
    const lines = sections.tables.split("\n").filter((l) => l.length > 0);
    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const line = lines[lineIdx];
      const cells = splitCsvRow(line);
      if (cells.length === 0) continue;
      const tag = cells[0];
      const spec = tablesSpec.find((s) => s.tag === tag);
      if (!spec) {
        throw new PackedDecodeError(
          `unknown table tag '${tag}'`,
          lineIdx + 1,
          1,
        );
      }
      const row: Record<string, unknown> = {};
      for (let i = 0; i < spec.columns.length; i++) {
        const col = spec.columns[i];
        const raw = cells[i + 1] ?? "";
        const unquoted = unquote(raw);
        const expanded =
          col.type === "str" ? legends.expand(unquoted) : unquoted;
        row[col.name] = castScalar(expanded, col.type);
      }
      if (!tables[tag]) tables[tag] = [];
      tables[tag].push(row);
    }
  }

  return {
    toolName: header.toolName,
    encoderId: header.encoderId,
    scalars,
    tables,
  };
}
