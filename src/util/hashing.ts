import * as crypto from "crypto";
import type { SymbolCard } from "../mcp/types.js";

export type NormalizedValue =
  | null
  | string
  | number
  | boolean
  | NormalizedValue[]
  | { [key: string]: NormalizedValue };

export function hashContent(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

export function generateSymbolId(
  repoId: string,
  relPath: string,
  kind: string,
  name: string,
  astFingerprint: string,
): string {
  const combined = `${repoId}:${relPath}:${kind}:${name}:${astFingerprint}`;
  return crypto.createHash("sha256").update(combined).digest("hex");
}

function normalizeObject(obj: unknown): NormalizedValue {
  if (obj === null || obj === undefined) {
    return null;
  }

  if (Array.isArray(obj)) {
    return obj.map(normalizeObject);
  }

  if (typeof obj === "object" && obj !== null) {
    if (obj instanceof Date) {
      return obj.toISOString();
    }
    if (obj instanceof Set) {
      return Array.from(obj).map(normalizeObject);
    }
    if (obj instanceof Map) {
      const entries: Record<string, NormalizedValue> = {};
      for (const [key, value] of obj) {
        entries[String(key)] = normalizeObject(value);
      }
      return entries;
    }
    const normalized: Record<string, NormalizedValue> = {};
    const sortedKeys = Object.keys(obj as Record<string, unknown>).sort();

    for (const key of sortedKeys) {
      const value = (obj as Record<string, unknown>)[key];
      if (value !== undefined) {
        normalized[key] = normalizeObject(value);
      }
    }

    return normalized;
  }

  return obj as NormalizedValue;
}

export function normalizeCard(card: SymbolCard): NormalizedValue {
  return normalizeObject(card);
}

export function hashCard(card: SymbolCard): string {
  const normalized = normalizeCard(card);
  const canonical = JSON.stringify(normalized);
  return hashContent(canonical);
}
