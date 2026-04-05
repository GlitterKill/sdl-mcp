/**
 * Rust-native SCIP decoder that wraps the napi-rs ScipDecodeHandle.
 *
 * Mirrors the native addon loading pattern from src/indexer/rustIndexer.ts.
 * Falls back gracefully when the native addon is unavailable.
 */

import { createRequire } from "module";
import { join } from "path";
import { fileURLToPath } from "url";
import { logger } from "../util/logger.js";
import type {
  ScipDecoder,
  ScipMetadata,
  ScipDocument,
  ScipExternalSymbol,
  ScipOccurrence,
  ScipDiagnostic,
  ScipSymbolInfo,
  ScipRelationship,
  ScipRange,
} from "./types.js";

const require = createRequire(import.meta.url);
const __dirname = fileURLToPath(new URL(".", import.meta.url));

// --- Native addon types (camelCase fields from napi-rs) ---

interface NapiScipRange {
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
}

interface NapiScipRelationship {
  symbol: string;
  isReference: boolean;
  isImplementation: boolean;
  isTypeDefinition: boolean;
  isDefinition: boolean;
}

interface NapiScipDiagnostic {
  severity: number;
  code: string;
  message: string;
  source: string;
  range?: NapiScipRange;
}

interface NapiScipOccurrence {
  range: NapiScipRange;
  symbol: string;
  symbolRoles: number;
  overrideDocumentation: string[];
  syntaxKind: number;
  diagnostics: NapiScipDiagnostic[];
}

interface NapiScipSymbolInfo {
  symbol: string;
  documentation: string[];
  relationships: NapiScipRelationship[];
  kind: number;
  displayName: string;
  signatureDocumentation?: string;
  enclosingSymbol?: string;
}

interface NapiScipDocument {
  language: string;
  relativePath: string;
  occurrences: NapiScipOccurrence[];
  symbols: NapiScipSymbolInfo[];
}

interface NapiScipExternalSymbol {
  symbol: string;
  documentation: string[];
  relationships: NapiScipRelationship[];
  kind: number;
  displayName: string;
  signatureDocumentation?: string;
}

interface NapiScipMetadata {
  version: number;
  toolName: string;
  toolVersion: string;
  toolArguments: string[];
  projectRoot: string;
  textDocumentEncoding: string;
}

/** The napi handle returned by scip_decode_start. */
interface NapiScipDecodeHandle {
  metadata(): NapiScipMetadata;
  nextDocument(): NapiScipDocument | null;
  externalSymbols(): NapiScipExternalSymbol[];
}

/** Subset of the native addon that includes SCIP decoder exports. */
interface ScipNativeAddon {
  scipDecodeStart(filePath: string): NapiScipDecodeHandle;
}

// --- Addon loading (mirrors rustIndexer.ts pattern) ---

let cachedAddon: ScipNativeAddon | null = null;
let loadAttempted = false;

function isScipCapableAddon(loaded: unknown): loaded is ScipNativeAddon {
  return (
    loaded !== null &&
    typeof loaded === "object" &&
    typeof (loaded as Record<string, unknown>).scipDecodeStart === "function"
  );
}

function loadScipAddon(): ScipNativeAddon | null {
  if (loadAttempted) return cachedAddon;
  loadAttempted = true;

  const disableEnv = process.env.SDL_MCP_DISABLE_NATIVE_ADDON ?? "";
  const disableNativeAddon = /^(1|true)$/i.test(disableEnv);
  if (disableNativeAddon) {
    logger.debug("SCIP native decoder disabled by SDL_MCP_DISABLE_NATIVE_ADDON");
    return null;
  }

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
      if (!isScipCapableAddon(loaded)) {
        logger.debug("Native addon found but missing SCIP decoder exports", {
          path: addonPath,
        });
        continue;
      }
      cachedAddon = loaded;
      logger.debug("Loaded native SCIP decoder", { path: addonPath });
      return loaded;
    } catch (error) {
      logger.debug("Failed to load native addon for SCIP decoder", {
        path: addonPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  logger.debug("Native SCIP decoder not available");
  return null;
}

// --- Conversion helpers (napi camelCase -> domain types) ---

function mapRange(r: NapiScipRange): ScipRange {
  return {
    startLine: r.startLine,
    startCol: r.startCol,
    endLine: r.endLine,
    endCol: r.endCol,
  };
}

function mapRelationship(r: NapiScipRelationship): ScipRelationship {
  return {
    symbol: r.symbol,
    isReference: r.isReference,
    isImplementation: r.isImplementation,
    isTypeDefinition: r.isTypeDefinition,
    isDefinition: r.isDefinition,
  };
}

function mapDiagnostic(d: NapiScipDiagnostic): ScipDiagnostic {
  return {
    severity: d.severity,
    code: d.code,
    message: d.message,
    source: d.source,
    range: d.range ? mapRange(d.range) : undefined,
  };
}

function mapOccurrence(o: NapiScipOccurrence): ScipOccurrence {
  return {
    range: mapRange(o.range),
    symbol: o.symbol,
    symbolRoles: o.symbolRoles,
    overrideDocumentation: o.overrideDocumentation,
    syntaxKind: o.syntaxKind,
    diagnostics: o.diagnostics.map(mapDiagnostic),
  };
}

function mapSymbolInfo(s: NapiScipSymbolInfo): ScipSymbolInfo {
  return {
    symbol: s.symbol,
    documentation: s.documentation,
    relationships: s.relationships.map(mapRelationship),
    kind: s.kind,
    displayName: s.displayName,
    signatureDocumentation: s.signatureDocumentation,
    enclosingSymbol: s.enclosingSymbol,
  };
}

function mapDocument(d: NapiScipDocument): ScipDocument {
  return {
    language: d.language,
    relativePath: d.relativePath,
    occurrences: d.occurrences.map(mapOccurrence),
    symbols: d.symbols.map(mapSymbolInfo),
  };
}

function mapExternalSymbol(s: NapiScipExternalSymbol): ScipExternalSymbol {
  return {
    symbol: s.symbol,
    documentation: s.documentation,
    relationships: s.relationships.map(mapRelationship),
    kind: s.kind,
    displayName: s.displayName,
    signatureDocumentation: s.signatureDocumentation,
  };
}

// --- Public API ---

/**
 * Returns true if the Rust SCIP decoder is available in the native addon.
 */
export function isRustScipDecoderAvailable(): boolean {
  return loadScipAddon() !== null;
}

/**
 * Rust-backed SCIP decoder implementing the ScipDecoder interface.
 *
 * Uses the napi-rs native addon to decode protobuf SCIP index files.
 * Documents are yielded one at a time via an async generator to support
 * streaming consumption of large SCIP indexes.
 */
export class RustScipDecoder implements ScipDecoder {
  private handle: NapiScipDecodeHandle | null = null;

  constructor(private readonly filePath: string) {}

  private ensureHandle(): NapiScipDecodeHandle {
    if (this.handle) return this.handle;

    const addon = loadScipAddon();
    if (!addon) {
      throw new Error(
        "Native SCIP decoder not available. " +
        "Install sdl-mcp-native or build the native addon.",
      );
    }

    this.handle = addon.scipDecodeStart(this.filePath);
    return this.handle;
  }

  async metadata(): Promise<ScipMetadata> {
    const handle = this.ensureHandle();
    const meta = handle.metadata();
    return {
      version: meta.version,
      toolName: meta.toolName,
      toolVersion: meta.toolVersion,
      toolArguments: meta.toolArguments,
      projectRoot: meta.projectRoot,
      textDocumentEncoding: meta.textDocumentEncoding,
    };
  }

  async *documents(): AsyncGenerator<ScipDocument> {
    const handle = this.ensureHandle();
    let doc = handle.nextDocument();
    while (doc !== null) {
      yield mapDocument(doc);
      doc = handle.nextDocument();
    }
  }

  async externalSymbols(): Promise<ScipExternalSymbol[]> {
    const handle = this.ensureHandle();
    return handle.externalSymbols().map(mapExternalSymbol);
  }

  close(): void {
    // Release the handle; GC will clean up the Rust side.
    this.handle = null;
  }
}
