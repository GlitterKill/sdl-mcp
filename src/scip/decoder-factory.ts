/**
 * Factory for creating SCIP decoders.
 *
 * Prefers the Rust native addon when available for streaming performance;
 * falls back to the TypeScript decoder that loads the full index into memory.
 */

import type { ScipDecoder } from "./types.js";
import { TypeScriptScipDecoder } from "./decoder-ts.js";

/**
 * Creates a SCIP decoder, preferring the Rust native addon if available.
 */
export async function createScipDecoder(
  filePath: string,
): Promise<ScipDecoder> {
  try {
    // Dynamic import to avoid loading native addon when not available
    const { isRustScipDecoderAvailable, RustScipDecoder } =
      await import("./decoder-rust.js");
    if (isRustScipDecoderAvailable()) {
      return new RustScipDecoder(filePath);
    }
  } catch {
    // Native addon not available, fall through to TS decoder
  }
  return new TypeScriptScipDecoder(filePath);
}

/**
 * Returns which decoder backend would be used.
 */
export async function getDecoderBackend(): Promise<"rust" | "typescript"> {
  try {
    const { isRustScipDecoderAvailable } = await import("./decoder-rust.js");
    if (isRustScipDecoderAvailable()) return "rust";
  } catch {
    // ignore
  }
  return "typescript";
}
