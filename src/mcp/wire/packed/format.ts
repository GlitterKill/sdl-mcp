/**
 * Packed wire format primitives.
 *
 * Header / scalars / tables / legend interning. Mirrors upstream
 * jcodemunch-mcp `format.py`, but emits the SDL-MCP-specific `#PACKED/<int>`
 * header rather than `#MUNCH/<int>` so payloads namespace cleanly.
 */

const HEADER_VERSION = 1;
const HEADER_PREFIX = "#PACKED";

export class Legends {
  private readonly prefixes: string[] = [];
  private readonly index = new Map<string, number>();

  /**
   * Add a literal prefix to the legend (1-based dense index). Returns the slot.
   * Idempotent: returns existing slot if the literal was already added.
   */
  add(literal: string): number {
    const existing = this.index.get(literal);
    if (existing !== undefined) return existing;
    const slot = this.prefixes.length + 1;
    this.prefixes.push(literal);
    this.index.set(literal, slot);
    return slot;
  }

  /** Lookup the slot for a literal, or 0 if absent. */
  lookup(literal: string): number {
    return this.index.get(literal) ?? 0;
  }

  /**
   * Replace a value with `@N<remainder>` if its prefix matches a registered
   * legend. Falls back to the original value otherwise.
   */
  replace(value: string): string {
    let bestSlot = 0;
    let bestLen = 0;
    for (const [literal, slot] of this.index) {
      if (literal.length > bestLen && value.startsWith(literal)) {
        bestSlot = slot;
        bestLen = literal.length;
      }
    }
    if (bestSlot === 0) return value;
    return `@${bestSlot}${value.slice(bestLen)}`;
  }

  /** Reverse: expand `@N<remainder>` back to the literal value. */
  expand(value: string): string {
    if (value.length < 2 || value[0] !== "@") return value;
    let i = 1;
    while (i < value.length && value[i] >= "0" && value[i] <= "9") i++;
    if (i === 1) return value;
    const slot = parseInt(value.slice(1, i), 10);
    if (slot < 1 || slot > this.prefixes.length) return value;
    return this.prefixes[slot - 1] + value.slice(i);
  }

  /** Render the legend section. Empty string when no literals registered. */
  render(): string {
    if (this.prefixes.length === 0) return "";
    return this.prefixes.map((p, i) => `@${i + 1}=${p}`).join("\n");
  }

  fromRendered(text: string): void {
    if (!text.trim()) return;
    for (const line of text.split("\n")) {
      if (!line.startsWith("@")) continue;
      const eq = line.indexOf("=");
      if (eq < 2) continue;
      const literal = line.slice(eq + 1);
      const slot = parseInt(line.slice(1, eq), 10);
      if (!Number.isFinite(slot) || slot < 1) continue;
      while (this.prefixes.length < slot) this.prefixes.push("");
      this.prefixes[slot - 1] = literal;
      this.index.set(literal, slot);
    }
  }

  size(): number {
    return this.prefixes.length;
  }
}

const QUOTE_CHARS = /[,= "\t]/;

/**
 * RFC-4180-style quoting with doubled-quote escape for `"`. Newlines and CR
 * inside scalars escape to `\n` / `\r` so the section separator survives —
 * audit fix F1 in the plan.
 */
export function quoteIfNeeded(value: string): string {
  let needsQuote = false;
  let escaped = "";
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === "\n") {
      escaped += "\\n";
      needsQuote = true;
    } else if (ch === "\r") {
      escaped += "\\r";
      needsQuote = true;
    } else if (ch === "\\") {
      escaped += "\\\\";
      needsQuote = true;
    } else if (ch === '"') {
      escaped += '""';
      needsQuote = true;
    } else {
      escaped += ch;
      if (QUOTE_CHARS.test(ch)) needsQuote = true;
    }
  }
  if (value === "") return '""';
  return needsQuote ? `"${escaped}"` : escaped;
}

/** Reverse of quoteIfNeeded. Returns the unquoted scalar value. */
export function unquote(value: string): string {
  if (value.length < 2 || value[0] !== '"' || value[value.length - 1] !== '"') {
    return value;
  }
  const inner = value.slice(1, -1);
  let result = "";
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === "\\" && i + 1 < inner.length) {
      const next = inner[i + 1];
      if (next === "n") {
        result += "\n";
        i++;
        continue;
      }
      if (next === "r") {
        result += "\r";
        i++;
        continue;
      }
      if (next === "\\") {
        result += "\\";
        i++;
        continue;
      }
    }
    if (ch === '"' && inner[i + 1] === '"') {
      result += '"';
      i++;
      continue;
    }
    result += ch;
  }
  return result;
}

export function writeHeader(toolName: string, encoderId: string): string {
  return `${HEADER_PREFIX}/${HEADER_VERSION} tool=${toolName} enc=${encoderId}`;
}

export interface ParsedHeader {
  version: number;
  toolName: string;
  encoderId: string;
}

export function parseHeader(line: string): ParsedHeader {
  if (!line.startsWith(HEADER_PREFIX + "/")) {
    throw new Error(
      `packed header expected ${HEADER_PREFIX}/<int>, got: ${line.slice(0, 32)}`,
    );
  }
  const rest = line.slice(HEADER_PREFIX.length + 1);
  const spaceIdx = rest.indexOf(" ");
  const versionStr = spaceIdx === -1 ? rest : rest.slice(0, spaceIdx);
  const version = parseInt(versionStr, 10);
  if (!Number.isFinite(version)) {
    throw new Error(`packed header has non-integer version: ${versionStr}`);
  }
  const params = spaceIdx === -1 ? "" : rest.slice(spaceIdx + 1);
  let toolName = "";
  let encoderId = "";
  for (const tok of params.split(/\s+/)) {
    if (tok.startsWith("tool=")) toolName = tok.slice(5);
    else if (tok.startsWith("enc=")) encoderId = tok.slice(4);
  }
  return { version, toolName, encoderId };
}

/**
 * Render scalars as a single line of `key=value` pairs. Reserved keys
 * (`__tables`, `__stypes`) are kept as raw literals (no quoting) since they
 * carry their own structure. Other values use `quoteIfNeeded`.
 */
export function writeScalars(scalars: Record<string, string>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(scalars)) {
    if (k === "__tables" || k === "__stypes") {
      parts.push(`${k}=${v}`);
    } else {
      parts.push(`${k}=${quoteIfNeeded(v)}`);
    }
  }
  return parts.join(" ");
}

/**
 * Parse scalars line back into a string→string map. Quoted values are
 * unquoted; reserved keys passed through verbatim.
 */
export function parseScalars(line: string): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  while (i < line.length) {
    while (i < line.length && (line[i] === " " || line[i] === "\t")) i++;
    if (i >= line.length) break;
    const eq = line.indexOf("=", i);
    if (eq === -1) break;
    const key = line.slice(i, eq);
    i = eq + 1;
    let value = "";
    if (line[i] === '"') {
      let j = i + 1;
      while (j < line.length) {
        if (line[j] === '"' && line[j + 1] === '"') {
          j += 2;
          continue;
        }
        if (line[j] === '"') break;
        j++;
      }
      value = line.slice(i, j + 1);
      i = j + 1;
    } else {
      const space = line.indexOf(" ", i);
      const tab = line.indexOf("\t", i);
      let end = line.length;
      if (space >= 0 && space < end) end = space;
      if (tab >= 0 && tab < end) end = tab;
      value = line.slice(i, end);
      i = end;
    }
    if (key === "__tables" || key === "__stypes") {
      out[key] = value;
    } else {
      out[key] = unquote(value);
    }
  }
  return out;
}

export interface TableRow {
  values: Array<string | number | boolean | null>;
}

export function writeTableRows(
  tag: string,
  rows: TableRow[],
  legends?: Legends,
  internCols?: Set<number>,
): string {
  const lines: string[] = [];
  for (const row of rows) {
    const cells: string[] = [tag];
    for (let i = 0; i < row.values.length; i++) {
      const v = row.values[i];
      let cell: string;
      if (v === null || v === undefined) cell = "";
      else if (typeof v === "boolean") cell = v ? "T" : "F";
      else if (typeof v === "number") cell = String(v);
      else cell = String(v);
      if (
        legends &&
        internCols &&
        internCols.has(i) &&
        cell.length > 0 &&
        typeof v === "string"
      ) {
        cell = legends.replace(cell);
      }
      cells.push(quoteIfNeeded(cell));
    }
    lines.push(cells.join(","));
  }
  return lines.join("\n");
}

/**
 * CSV row split honoring RFC-4180 quoting. Returns the cells (un-unquoted).
 */
export function splitCsvRow(line: string): string[] {
  const cells: string[] = [];
  let i = 0;
  while (i <= line.length) {
    if (i === line.length) {
      cells.push("");
      break;
    }
    if (line[i] === '"') {
      let j = i + 1;
      while (j < line.length) {
        if (line[j] === '"' && line[j + 1] === '"') {
          j += 2;
          continue;
        }
        if (line[j] === '"') break;
        j++;
      }
      const cell = line.slice(i, j + 1);
      i = j + 1;
      cells.push(cell);
      if (i < line.length && line[i] === ",") i++;
      else if (i === line.length) break;
    } else {
      const comma = line.indexOf(",", i);
      if (comma === -1) {
        cells.push(line.slice(i));
        break;
      }
      cells.push(line.slice(i, comma));
      i = comma + 1;
    }
  }
  return cells;
}

/**
 * Split a packed payload into header / legend / scalars / tables sections by
 * blank-line boundaries. Header always present; legend optional; scalars
 * present whenever any sections after header exist; remainder is table block.
 */
export interface PackedSections {
  header: string;
  legend: string;
  scalars: string;
  tables: string;
}

export function splitSections(payload: string): PackedSections {
  const trimmed = payload.endsWith("\n") ? payload.slice(0, -1) : payload;
  const blocks = trimmed.split("\n\n");
  if (blocks.length === 0 || !blocks[0]) {
    throw new Error("packed payload empty");
  }
  const headerLine = blocks[0].split("\n", 1)[0];
  let legend = "";
  let scalars = "";
  let tables = "";
  if (blocks[0].includes("\n")) {
    const remainder = blocks[0].slice(headerLine.length + 1);
    if (remainder.startsWith("@")) legend = remainder;
  }
  let cursor = 1;
  if (cursor < blocks.length) {
    scalars = blocks[cursor];
    cursor++;
  }
  if (cursor < blocks.length) {
    tables = blocks.slice(cursor).join("\n\n");
  }
  return { header: headerLine, legend, scalars, tables };
}

/**
 * Assemble final wire payload from parts. Trailing newline included.
 */
export function assemble(parts: {
  header: string;
  legend: string;
  scalars: string;
  tables: string;
}): string {
  const sections: string[] = [];
  if (parts.legend) {
    sections.push(parts.header + "\n" + parts.legend);
  } else {
    sections.push(parts.header);
  }
  if (parts.scalars) sections.push(parts.scalars);
  if (parts.tables) sections.push(parts.tables);
  return sections.join("\n\n") + "\n";
}

export const PACKED_HEADER_VERSION = HEADER_VERSION;
export const PACKED_HEADER_PREFIX = HEADER_PREFIX;
