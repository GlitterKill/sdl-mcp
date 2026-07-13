/**
 * Encoder registry — maps encoderId → encode + tool tag. Decoder is
 * schema-free (lives in decoder.ts) so new encoders ship without bumping
 * the decoder version.
 */

import {
  encodePackedSlice,
  SLICE_ENCODER_ID,
  SLICE_SHORT_ID_ENCODER_ID,
} from "./slice.js";
import {
  encodePackedSymbolSearch,
  SYMBOL_SEARCH_ENCODER_ID,
  SYMBOL_SEARCH_SHORT_ID_ENCODER_ID,
} from "./symbol-search.js";
import {
  encodePackedContext,
  CONTEXT_ENCODER_ID,
  CONTEXT_SHORT_ID_ENCODER_ID,
} from "./context.js";
import type { PackedShortIdOptions } from "../short-ids.js";

export interface RegisteredEncoder {
  id: string;
  shortId: string;
  toolName: string;
  encode: (value: unknown, options?: PackedShortIdOptions) => string;
  markDeliveredOnPacked: boolean;
}

const REGISTRY = new Map<string, RegisteredEncoder>();
const TOOL_REGISTRY = new Map<string, RegisteredEncoder>();

const sliceEncoder: RegisteredEncoder = {
  id: SLICE_ENCODER_ID,
  shortId: SLICE_SHORT_ID_ENCODER_ID,
  toolName: "slice.build",
  encode: (value, options) =>
    encodePackedSlice(
      value as Parameters<typeof encodePackedSlice>[0],
      options,
    ),
  markDeliveredOnPacked: true,
};
const symbolSearchEncoder: RegisteredEncoder = {
  id: SYMBOL_SEARCH_ENCODER_ID,
  shortId: SYMBOL_SEARCH_SHORT_ID_ENCODER_ID,
  toolName: "symbol.search",
  encode: (value, options) =>
    encodePackedSymbolSearch(
      value as Parameters<typeof encodePackedSymbolSearch>[0],
      options,
    ),
  markDeliveredOnPacked: true,
};
const contextEncoder: RegisteredEncoder = {
  id: CONTEXT_ENCODER_ID,
  shortId: CONTEXT_SHORT_ID_ENCODER_ID,
  toolName: "context",
  encode: (value, options) =>
    encodePackedContext(
      value as Parameters<typeof encodePackedContext>[0],
      options,
    ),
  markDeliveredOnPacked: false,
};

for (const encoder of [sliceEncoder, symbolSearchEncoder, contextEncoder]) {
  REGISTRY.set(encoder.id, encoder);
  TOOL_REGISTRY.set(encoder.toolName, encoder);
}

export function getEncoder(id: string): RegisteredEncoder | undefined {
  return REGISTRY.get(id);
}

export function listEncoders(): string[] {
  return Array.from(REGISTRY.keys());
}

export function getEncoderForTool(
  toolName: string,
): RegisteredEncoder | undefined {
  return TOOL_REGISTRY.get(toolName.replace(/^sdl\./, ""));
}
