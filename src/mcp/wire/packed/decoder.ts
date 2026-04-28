/**
 * Schema-free packed payload decoder. Reads `__tables` / `__stypes` to
 * reconstruct the object — new encoders can ship without bumping the
 * decoder version.
 *
 * Header check accepts only `#PACKED/<int>`; upstream `#MUNCH/<int>`
 * payloads are rejected (different tool surface).
 */

import { parseScalars, splitSections } from "./format.js";
import { decodeSchemaDriven, parseTablesScalar } from "./schema.js";
import type { TableSpec } from "./types.js";
import { PackedDecodeError } from "./types.js";

export interface DecodedPacked {
  toolName: string;
  encoderId: string;
  data: Record<string, unknown>;
}

export function decodePacked(payload: string): DecodedPacked {
  if (typeof payload !== "string" || !payload.startsWith("#PACKED/")) {
    throw new PackedDecodeError("payload missing #PACKED/<int> header", 1, 1);
  }
  const sections = splitSections(payload);
  const decoded = decodeSchemaDriven(sections);
  const rawScalars = parseScalars(sections.scalars);
  const tableSpecs = parseTablesScalar(rawScalars.__tables ?? "");
  const data: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(decoded.scalars)) {
    if (k === "__tables" || k === "__stypes") continue;
    data[k] = v;
  }
  for (const [tag, rows] of Object.entries(decoded.tables)) {
    const spec = tableSpecs.find((s) => s.tag === tag);
    if (!spec) continue;
    const restored = rows.map((row) => {
      const out: Record<string, unknown> = {};
      for (const col of spec.columns) {
        const decodedName = col.name.replace(/%([0-9A-Fa-f]{2})/g, (_, h) =>
          String.fromCharCode(parseInt(h, 16)),
        );
        out[decodedName] = row[col.name];
      }
      return out;
    });
    data[spec.key] = restored;
  }
  return {
    toolName: decoded.toolName,
    encoderId: decoded.encoderId,
    data,
  };
}

export function tryDecodePacked(payload: string): DecodedPacked | null {
  try {
    return decodePacked(payload);
  } catch {
    return null;
  }
}

export type { TableSpec };
