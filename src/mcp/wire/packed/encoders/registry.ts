/**
 * Encoder registry — maps encoderId → encode + tool tag. Decoder is
 * schema-free (lives in decoder.ts) so new encoders ship without bumping
 * the decoder version.
 */

import { encodePackedSlice, SLICE_ENCODER_ID } from "./slice.js";
import {
  encodePackedSymbolSearch,
  SYMBOL_SEARCH_ENCODER_ID,
} from "./symbol-search.js";
import { encodePackedContext, CONTEXT_ENCODER_ID } from "./context.js";

export interface RegisteredEncoder {
  id: string;
  toolName: string;
  encode: (value: unknown) => string;
}

const REGISTRY = new Map<string, RegisteredEncoder>();

REGISTRY.set(SLICE_ENCODER_ID, {
  id: SLICE_ENCODER_ID,
  toolName: "slice.build",
  encode: (v) =>
    encodePackedSlice(v as Parameters<typeof encodePackedSlice>[0]),
});
REGISTRY.set(SYMBOL_SEARCH_ENCODER_ID, {
  id: SYMBOL_SEARCH_ENCODER_ID,
  toolName: "symbol.search",
  encode: (v) =>
    encodePackedSymbolSearch(
      v as Parameters<typeof encodePackedSymbolSearch>[0],
    ),
});
REGISTRY.set(CONTEXT_ENCODER_ID, {
  id: CONTEXT_ENCODER_ID,
  toolName: "context",
  encode: (v) =>
    encodePackedContext(v as Parameters<typeof encodePackedContext>[0]),
});

export function getEncoder(id: string): RegisteredEncoder | undefined {
  return REGISTRY.get(id);
}

export function listEncoders(): string[] {
  return Array.from(REGISTRY.keys());
}
