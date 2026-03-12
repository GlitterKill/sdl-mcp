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
import type { ClusterAssignment, ProcessTrace } from "./cluster-types.js";

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
  signature?: {
    params?: Array<{ name: string; typeName?: string }>;
    returns?: string;
    generics?: string[];
  };
  summary: string;
  invariants: string[];
  sideEffects: string[];
  roleTags: string[];
  searchText: string;
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

interface NativeClusterSymbol {
  symbolId: string;
}

interface NativeClusterEdge {
  fromSymbolId: string;
  toSymbolId: string;
}

interface NativeClusterAssignment {
  symbolId: string;
  clusterId: string;
  membershipScore: number;
}

interface NativeProcessSymbol {
  symbolId: string;
  name: string;
}

interface NativeProcessCallEdge {
  callerId: string;
  calleeId: string;
}

interface NativeProcessStep {
  symbolId: string;
  stepOrder: number;
}

interface NativeProcess {
  processId: string;
  entrySymbolId: string;
  steps: NativeProcessStep[];
  depth: number;
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
  computeClusters?(
    symbols: NativeClusterSymbol[],
    edges: NativeClusterEdge[],
    minClusterSize: number,
  ): NativeClusterAssignment[];
  traceProcesses?(
    symbols: NativeProcessSymbol[],
    callEdges: NativeProcessCallEdge[],
    maxDepth: number,
    entryPatterns: string[],
  ): NativeProcess[];
}

// --- Addon loading ---

let nativeAddon: NativeAddon | null = null;
let loadAttempted = false;
let nativeDisableLogged = false;

function isCompatibleNativeAddon(addon: unknown): addon is NativeAddon {
  if (!addon || typeof addon !== "object") return false;

  const maybe = addon as Partial<NativeAddon>;
  return (
    typeof maybe.parseFiles === "function" &&
    typeof maybe.hashContentNative === "function" &&
    typeof maybe.generateSymbolIdNative === "function"
  );
}

function loadNativeAddon(): NativeAddon | null {
  const disableNativeAddon = /^(1|true)$/i.test(
    process.env.SDL_MCP_DISABLE_NATIVE_ADDON ?? "",
  );
  if (disableNativeAddon) {
    if (!nativeDisableLogged) {
      logger.info("Native Rust indexer explicitly disabled by environment");
      nativeDisableLogged = true;
    }
    return null;
  }
  // Reset so toggling the env var at runtime re-emits the log on the next disable.
  nativeDisableLogged = false;

  if (loadAttempted) return nativeAddon;
  loadAttempted = true;

  const overridePath = process.env.SDL_MCP_NATIVE_ADDON_PATH;
  const paths = [
    ...(overridePath ? [overridePath] : []),
    // Development: built in native/ directory (local dev builds)
    join(__dirname, "..", "..", "native", "sdl-mcp-native.node"),
    join(__dirname, "..", "..", "native", "index.node"),
    // Umbrella package with platform-detection loader (installed via npm)
    "sdl-mcp-native",
  ];

  for (const addonPath of paths) {
    try {
      const loaded = require(addonPath) as unknown;
      if (!isCompatibleNativeAddon(loaded)) {
        logger.warn("Native Rust indexer found but incompatible; ignoring", {
          path: addonPath,
          exports:
            loaded && typeof loaded === "object" ? Object.keys(loaded) : [],
        });
        continue;
      }

      nativeAddon = loaded;
      logger.info("Loaded native Rust indexer", { path: addonPath });
      return loaded;
    } catch (error) {
      logger.debug("Failed to load native Rust indexer candidate", {
        path: addonPath,
        error: error instanceof Error ? error.message : String(error),
      });
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
  roleTagsJson: string;
  searchText: string;
}

export interface RustParseResult {
  relPath: string;
  contentHash: string;
  symbols: RustExtractedSymbol[];
  imports: ExtractedImport[];
  calls: ExtractedCall[];
  parseError: string | null;
}

// Native extraction supports all languages with dedicated Rust extractors.
// Kotlin is excluded: no tree-sitter-kotlin Rust crate exists (stays on TS path).
const NATIVE_EXTRACTION_LANGUAGES = new Set([
  "ts",
  "tsx",
  "js",
  "jsx", // Tier 0 (original)
  "py",
  "go",
  "java", // Tier 1
  "rs",
  "cs",
  "cpp",
  "c", // Tier 2
  "php",
  "sh", // Tier 3
  // "kt" — deferred: no tree-sitter-kotlin Rust crate
]);

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

function supportsNativeExtractionLanguage(language: string): boolean {
  return NATIVE_EXTRACTION_LANGUAGES.has(language);
}

function buildUnsupportedLanguageResult(
  relPath: string,
  language: string,
): RustParseResult {
  return {
    relPath,
    contentHash: "",
    symbols: [],
    imports: [],
    calls: [],
    parseError: `Unsupported language: ${language || "unknown"}`,
  };
}

/**
 * Maximum number of files to send to the native addon in a single batch.
 * Bounds peak memory usage in Rust (all file contents + parse results are
 * held in memory simultaneously per batch). Smaller batches also reduce the
 * probability of hitting a pathological file that crashes the native addon.
 */
const NATIVE_BATCH_SIZE = 1000;

/**
 * Parse a batch of files using the native Rust engine.
 *
 * Files are processed in chunks of NATIVE_BATCH_SIZE to bound memory usage
 * and limit blast radius from crashes in the native addon.
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

  const results = new Array<RustParseResult | null>(files.length).fill(null);
  const nativeEntries: Array<{ index: number; input: NativeFileInput }> = [];

  // Convert FileMetadata to NativeFileInput for languages with native
  // extraction parity. Other languages stay on the TS fallback path.
  files.forEach((file, index) => {
    const ext = file.path.split(".").pop()?.toLowerCase() ?? "";
    const language = extensionToLanguage(ext);

    if (!supportsNativeExtractionLanguage(language)) {
      results[index] = buildUnsupportedLanguageResult(
        file.path,
        language || ext,
      );
      return;
    }

    nativeEntries.push({
      index,
      input: {
        relPath: file.path,
        absolutePath: join(repoRoot, file.path).replace(/\\/g, "/"),
        repoId,
        language,
      },
    });
  });

  if (nativeEntries.length === 0) {
    return results.filter(
      (result): result is RustParseResult => result !== null,
    );
  }

  for (
    let offset = 0;
    offset < nativeEntries.length;
    offset += NATIVE_BATCH_SIZE
  ) {
    const batchEntries = nativeEntries.slice(
      offset,
      offset + NATIVE_BATCH_SIZE,
    );
    const batch = batchEntries.map((entry) => entry.input);

    if (nativeEntries.length > NATIVE_BATCH_SIZE) {
      logger.debug("Processing native parse batch", {
        batch: Math.floor(offset / NATIVE_BATCH_SIZE) + 1,
        totalBatches: Math.ceil(nativeEntries.length / NATIVE_BATCH_SIZE),
        batchSize: batch.length,
        totalFiles: nativeEntries.length,
      });
    }

    // Call native addon for this batch
    let nativeResults: NativeParsedFile[];
    try {
      nativeResults = addon.parseFiles(batch, threadCount);
    } catch (error) {
      logger.error(
        "Native Rust indexer parseFiles failed; disabling native addon",
        {
          error,
          batchOffset: offset,
          batchSize: batch.length,
        },
      );
      nativeAddon = null;
      return null;
    }

    if (nativeResults.length !== batch.length) {
      logger.error("Native Rust indexer returned unexpected result count", {
        expected: batch.length,
        actual: nativeResults.length,
        batchOffset: offset,
      });
      nativeAddon = null;
      return null;
    }

    // Convert NativeParsedFile to RustParseResult
    try {
      const mapped = nativeResults.map(mapNativeResult);
      mapped.forEach((result, batchIndex) => {
        results[batchEntries[batchIndex]!.index] = result;
      });
    } catch (error) {
      logger.error(
        "Failed to map native Rust indexer results; disabling native addon",
        {
          error,
          batchOffset: offset,
        },
      );
      nativeAddon = null;
      return null;
    }
  }

  return results.filter((result): result is RustParseResult => result !== null);
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

export function computeClustersRust(
  symbols: NativeClusterSymbol[],
  edges: NativeClusterEdge[],
  minClusterSize: number = 3,
): ClusterAssignment[] | null {
  const addon = loadNativeAddon();
  if (!addon?.computeClusters) return null;

  try {
    return addon.computeClusters(symbols, edges, minClusterSize);
  } catch (error) {
    logger.error(
      "Native Rust cluster detection failed; falling back to TypeScript",
      {
        error,
      },
    );
    return null;
  }
}

export function traceProcessesRust(
  symbols: NativeProcessSymbol[],
  callEdges: NativeProcessCallEdge[],
  maxDepth: number = 20,
  entryPatterns: string[] = [],
): ProcessTrace[] | null {
  const addon = loadNativeAddon();
  if (!addon?.traceProcesses) return null;

  try {
    return addon.traceProcesses(symbols, callEdges, maxDepth, entryPatterns);
  } catch (error) {
    logger.error(
      "Native Rust process tracing failed; falling back to TypeScript",
      {
        error,
      },
    );
    return null;
  }
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
    // Rust returns a typed NativeSymbolSignature. When all fields are empty
    // (no params, no return type, no generics) the Rust side returns `undefined`.
    // Guard on the object itself so signatures with returns/generics but zero
    // params are not silently discarded.
    signature: sym.signature
      ? {
          params: (sym.signature.params ?? []).map((p) => ({
            name: p.name,
            type: p.typeName,
          })),
          returns: sym.signature.returns,
          generics: sym.signature.generics,
        }
      : undefined,
    summary: sym.summary,
    // Downstream Ladybug persistence still expects JSON strings for these arrays;
    // re-serialise here rather than changing every write path.
    invariantsJson:
      sym.invariants.length > 0 ? JSON.stringify(sym.invariants) : "[]",
    sideEffectsJson:
      sym.sideEffects.length > 0 ? JSON.stringify(sym.sideEffects) : "[]",
    roleTagsJson: sym.roleTags.length > 0 ? JSON.stringify(sym.roleTags) : "[]",
    searchText: typeof sym.searchText === "string" ? sym.searchText : "",
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

function mapCallType(rustType: string): ExtractedCall["callType"] {
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
