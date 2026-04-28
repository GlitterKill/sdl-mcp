/**
 * `gen1` generic fallback encoder. Walks an arbitrary JSON-like object and
 * emits a packed payload by inferring tables from arrays-of-objects with
 * homogeneous keys.
 *
 * Per audit fix F11: keys containing the column separators `: | , %` are
 * percent-escaped inside `__tables` so they round-trip through the parser.
 */

import { encodeSchemaDriven } from "./schema.js";
import type { TableSpec, ScalarTypeMap } from "./types.js";

const ESCAPE_TARGETS = /[:|,% ]/g;

function escapeColumnName(name: string): string {
  return name.replace(
    ESCAPE_TARGETS,
    (ch) => "%" + ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0"),
  );
}

function inferColumnType(values: unknown[]): "str" | "int" | "float" | "bool" {
  let allBool = true;
  let allInt = true;
  let allNumber = true;
  for (const v of values) {
    if (v === null || typeof v === "undefined") continue;
    if (typeof v !== "boolean") allBool = false;
    if (typeof v !== "number" || !Number.isInteger(v)) allInt = false;
    if (typeof v !== "number") allNumber = false;
  }
  if (allBool) return "bool";
  if (allInt) return "int";
  if (allNumber) return "float";
  return "str";
}

interface InferredTable {
  spec: TableSpec;
  rows: Array<Record<string, unknown>>;
}

function inferTable(
  tag: string,
  key: string,
  items: unknown[],
): InferredTable | null {
  if (!Array.isArray(items) || items.length === 0) return null;
  const objects = items.filter(
    (x): x is Record<string, unknown> =>
      typeof x === "object" && x !== null && !Array.isArray(x),
  );
  if (objects.length === 0) return null;
  const keys = new Set<string>();
  for (const obj of objects) {
    for (const k of Object.keys(obj)) keys.add(k);
  }
  const orderedKeys = Array.from(keys);
  const columns = orderedKeys.map((k) => ({
    name: escapeColumnName(k),
    type: inferColumnType(objects.map((o) => o[k])),
  }));
  const rows = objects.map((obj) => {
    const row: Record<string, unknown> = {};
    for (let i = 0; i < orderedKeys.length; i++) {
      const orig = orderedKeys[i];
      row[columns[i].name] = obj[orig];
    }
    return row;
  });
  return { spec: { tag, key, columns }, rows };
}

const TAG_ALPHABET = "abcdefghijklmnopqrstuvwxyz";

/**
 * Encode an arbitrary object using the generic shape-sniffer. Top-level
 * arrays-of-objects become tables; everything else becomes scalars.
 */
export function encodeGeneric(toolName: string, value: unknown): string {
  if (typeof value !== "object" || value === null) {
    return encodeSchemaDriven({
      toolName,
      encoderId: "gen1",
      scalars: { _value: value as never },
      scalarTypes: {
        _value:
          typeof value === "number" && Number.isInteger(value) ? "int" : "str",
      },
      tables: [],
    });
  }
  const obj = value as Record<string, unknown>;
  const scalars: Record<string, unknown> = {};
  const scalarTypes: ScalarTypeMap = {};
  const tables: InferredTable[] = [];
  const legendCandidates: string[] = [];
  let tagIdx = 0;
  for (const [k, v] of Object.entries(obj)) {
    if (
      Array.isArray(v) &&
      v.length > 0 &&
      typeof v[0] === "object" &&
      v[0] !== null
    ) {
      const tag = TAG_ALPHABET[tagIdx % TAG_ALPHABET.length];
      tagIdx++;
      const table = inferTable(tag, k, v);
      if (table) {
        tables.push(table);
        for (const row of table.rows) {
          for (const cell of Object.values(row)) {
            if (typeof cell === "string" && cell.includes("/"))
              legendCandidates.push(cell);
          }
        }
        continue;
      }
    }
    if (v === null || typeof v === "undefined") {
      scalars[k] = "";
      scalarTypes[k] = "str";
    } else if (
      typeof v === "boolean" ||
      typeof v === "number" ||
      typeof v === "string"
    ) {
      scalars[k] = v;
    } else {
      scalars[k] = v;
      scalarTypes[k] = "json";
    }
  }
  return encodeSchemaDriven({
    toolName,
    encoderId: "gen1",
    scalars,
    scalarTypes,
    tables,
    legendCandidates,
  });
}

/**
 * Decode helper that reconstructs an object from a generic-encoded payload.
 * The tag→key mapping comes from `__tables`, so structure is preserved.
 */
export function decodeGeneric(decoded: {
  scalars: Record<string, unknown>;
  tables: Record<string, Array<Record<string, unknown>>>;
  tablesByTag: Map<
    string,
    { key: string; columns: { name: string; type: string }[] }
  >;
}): unknown {
  const result: Record<string, unknown> = { ...decoded.scalars };
  for (const [tag, rows] of Object.entries(decoded.tables)) {
    const meta = decoded.tablesByTag.get(tag);
    if (!meta) continue;
    const realKey = meta.key;
    const restored = rows.map((row) => {
      const out: Record<string, unknown> = {};
      for (const col of meta.columns) {
        const decodedName = col.name.replace(/%([0-9A-Fa-f]{2})/g, (_, h) =>
          String.fromCharCode(parseInt(h, 16)),
        );
        out[decodedName] = row[col.name];
      }
      return out;
    });
    result[realKey] = restored;
  }
  return result;
}
