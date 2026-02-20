/**
 * Rust-based indexer integration for SDL-MCP.
 *
 * This module provides a TypeScript wrapper around the native Rust addon
 * built with napi-rs. It translates between the Rust NativeParsedFile
 * format and the existing TypeScript extraction types used by the indexer.
 *
 * The Rust engine handles Pass 1 (parsing + extraction) via tree-sitter
 * and Rayon parallelism. Pass 2 (TypeScript compiler API resolution)
 * remains in TypeScript.
 */

import { createRequire } from "module";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { logger } from "../util/logger.js";
import type { ExtractedImport } from "./treesitter/extractImports.js";
import type {
  ExtractedCall,
  ExtractedSymbol as CallExtractedSymbol,
} from "./treesitter/extractCalls.js";
import type { FileMetadata } from "./fileScanner.js";

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

// --- napi-rs type interfaces (mirrors native/src/types.rs) ---

interface NativeFileInput {
  relPath: string;
  absolutePath: string;
  repoId: string;
  language: string;
}

interface NativeRange {
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
}

interface NativeParsedSymbol {
  symbolId: string;
  astFingerprint: string;
  kind: string;
  name: string;
  exported: boolean;
  visibility: string;
  range: NativeRange;
  signatureJson: string;
  summary: string;
  invariantsJson: string;
  sideEffectsJson: string;
}

interface NativeParsedImport {
  specifier: string;
  isRelative: boolean;
  isExternal: boolean;
  namedImports: string[];
  defaultImport: string | null;
  namespaceImport: string | null;
  range: NativeRange;
}

interface NativeParsedCall {
  callerName: string;
  calleeIdentifier: string;
  callType: string;
  range: NativeRange;
}

interface NativeParsedFile {
  relPath: string;
  contentHash: string;
  symbols: NativeParsedSymbol[];
  imports: NativeParsedImport[];
  calls: NativeParsedCall[];
  parseError: string | null;
}

interface NativeAddon {
  parseFiles(files: NativeFileInput[], threadCount: number): NativeParsedFile[];
  hashContentNative(content: string): string;
  generateSymbolIdNative(
    repoId: string,
    relPath: string,
    kind: string,
    name: string,
    fingerprint: string,
  ): string;
}

// --- Addon loading ---

let nativeAddon: NativeAddon | null = null;
let loadAttempted = false;

function loadNativeAddon(): NativeAddon | null {
  if (loadAttempted) return nativeAddon;
  loadAttempted = true;

  const paths = [
    // Development: built in native/ directory
    join(__dirname, "..", "..", "native", "sdl-mcp-native.node"),
    join(__dirname, "..", "..", "native", "index.node"),
    // npm package: prebuilt binaries
    "sdl-mcp-native",
    "@sdl-mcp/native",
  ];

  for (const addonPath of paths) {
    try {
      nativeAddon = require(addonPath) as NativeAddon;
      logger.info("Loaded native Rust indexer", { path: addonPath });
      return nativeAddon;
    } catch {
      // Try next path
    }
  }

  logger.warn("Native Rust indexer not available, using TypeScript engine");
  return null;
}

// --- Public API ---

/**
 * Check if the native Rust indexer is available.
 */
export function isRustEngineAvailable(): boolean {
  return loadNativeAddon() !== null;
}

/**
 * Result from parsing a batch of files with the Rust engine.
 */
export interface RustExtractedSymbol extends CallExtractedSymbol {
  symbolId: string;
  astFingerprint: string;
  summary: string;
  invariantsJson: string;
  sideEffectsJson: string;
}

export interface RustParseResult {
  relPath: string;
  contentHash: string;
  symbols: RustExtractedSymbol[];
  imports: ExtractedImport[];
  calls: ExtractedCall[];
  parseError: string | null;
}

/**
 * Map file extension to language identifier.
 */
function extensionToLanguage(ext: string): string {
  const map: Record<string, string> = {
    ts: "ts",
    tsx: "tsx",
    js: "js",
    mjs: "js",
    cjs: "js",
    jsx: "jsx",
    py: "py",
    go: "go",
    java: "java",
    cs: "cs",
    c: "c",
    h: "c",
    cpp: "cpp",
    cc: "cpp",
    cxx: "cpp",
    hpp: "cpp",
    php: "php",
    rs: "rs",
    kt: "kt",
    kts: "kt",
    sh: "sh",
    bash: "sh",
    zsh: "sh",
  };
  return map[ext] ?? "";
}

/**
 * Parse a batch of files using the native Rust engine.
 *
 * @param repoId - Repository identifier
 * @param repoRoot - Absolute path to repo root
 * @param files - File metadata from scanner
 * @param threadCount - Number of Rayon threads (0 = auto)
 * @returns Parsed results per file, or null if Rust engine unavailable
 */
export function parseFilesRust(
  repoId: string,
  repoRoot: string,
  files: FileMetadata[],
  threadCount: number = 0,
): RustParseResult[] | null {
  const addon = loadNativeAddon();
  if (!addon) return null;

  // Convert FileMetadata to NativeFileInput
  const inputs: NativeFileInput[] = files.map((file) => {
    const ext = file.path.split(".").pop()?.toLowerCase() ?? "";
    return {
      relPath: file.path,
      absolutePath: join(repoRoot, file.path).replace(/\\/g, "/"),
      repoId,
      language: extensionToLanguage(ext),
    };
  });

  // Call native addon
  const nativeResults = addon.parseFiles(inputs, threadCount);

  // Convert NativeParsedFile to RustParseResult
  return nativeResults.map(mapNativeResult);
}

/**
 * Hash content using the native Rust engine (for parity testing).
 */
export function hashContentRust(content: string): string | null {
  const addon = loadNativeAddon();
  if (!addon) return null;
  return addon.hashContentNative(content);
}

/**
 * Generate symbol ID using the native Rust engine (for parity testing).
 */
export function generateSymbolIdRust(
  repoId: string,
  relPath: string,
  kind: string,
  name: string,
  fingerprint: string,
): string | null {
  const addon = loadNativeAddon();
  if (!addon) return null;
  return addon.generateSymbolIdNative(repoId, relPath, kind, name, fingerprint);
}

// --- Type mapping ---

function mapNativeResult(native: NativeParsedFile): RustParseResult {
  return {
    relPath: native.relPath,
    contentHash: native.contentHash,
    symbols: native.symbols.map(mapNativeSymbol),
    imports: native.imports.map(mapNativeImport),
    calls: native.calls.map(mapNativeCall),
    parseError: native.parseError,
  };
}

function mapNativeSymbol(sym: NativeParsedSymbol): RustExtractedSymbol {
  const signature = safeJsonParse(sym.signatureJson);

  return {
    nodeId: sym.name,
    symbolId: sym.symbolId,
    astFingerprint: sym.astFingerprint,
    name: sym.name,
    kind: sym.kind as CallExtractedSymbol["kind"],
    exported: sym.exported,
    visibility: sym.visibility
      ? (sym.visibility as "public" | "private" | "protected" | "internal")
      : undefined,
    range: {
      startLine: sym.range.startLine,
      startCol: sym.range.startCol,
      endLine: sym.range.endLine,
      endCol: sym.range.endCol,
    },
    signature: signature?.params && Array.isArray(signature.params)
      ? {
          params: signature.params as Array<{ name: string; type?: string }>,
          returns: signature.returns as string | undefined,
          generics: signature.generics as string[] | undefined,
        }
      : undefined,
    summary: sym.summary,
    invariantsJson: sym.invariantsJson,
    sideEffectsJson: sym.sideEffectsJson,
  };
}

function mapNativeImport(imp: NativeParsedImport): ExtractedImport {
  return {
    specifier: imp.specifier,
    isRelative: imp.isRelative,
    isExternal: imp.isExternal,
    imports: imp.namedImports,
    defaultImport: imp.defaultImport ?? undefined,
    namespaceImport: imp.namespaceImport ?? undefined,
    isReExport: false,
  };
}

function mapNativeCall(call: NativeParsedCall): ExtractedCall {
  return {
    callerNodeId: call.callerName,
    calleeIdentifier: call.calleeIdentifier,
    isResolved: false,
    callType: mapCallType(call.callType),
    range: {
      startLine: call.range.startLine,
      startCol: call.range.startCol,
      endLine: call.range.endLine,
      endCol: call.range.endCol,
    },
  };
}

function mapCallType(
  rustType: string,
): ExtractedCall["callType"] {
  switch (rustType) {
    case "direct":
      return "function";
    case "method":
      return "method";
    case "constructor":
      return "constructor";
    case "dynamic":
      return "dynamic";
    case "computed":
      return "computed";
    case "tagged_template":
      return "tagged-template";
    default:
      return "function";
  }
}

function safeJsonParse(json: string): Record<string, unknown> | null {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}
