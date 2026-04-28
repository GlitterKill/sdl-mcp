/**
 * Agent-side helper for unwrapping wire-format responses. When a slice or
 * symbol-search response is encoded with `packed`, the payload is a string
 * carrying the `#PACKED/1` header; everything else passes through.
 */

import { decodePacked } from "../mcp/wire/packed/index.js";
import type { WireFormatResult } from "../mcp/wire/packed/index.js";

export function unpackWireResult(result: WireFormatResult): unknown {
  if (result.format === "packed") {
    return decodePacked(result.payload).data;
  }
  return result.payload;
}

/**
 * Best-effort unpack from a raw payload — accepts strings starting with
 * `#PACKED/`, returns the decoded object; returns the input unchanged
 * otherwise. Useful when the caller only sees the response slice and not
 * the discriminated union.
 */
export function tryUnpackPayload(payload: unknown): unknown {
  if (typeof payload !== "string") return payload;
  if (!payload.startsWith("#PACKED/")) return payload;
  try {
    return decodePacked(payload).data;
  } catch {
    return payload;
  }
}
