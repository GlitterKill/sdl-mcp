import type { RepoConfig } from "../../config/types.js";
import type { EdgeRow, SymbolRow, SymbolReferenceRow } from "../../db/ladybug-queries.js";
import type {
  PendingCallEdge,
  SymbolIndex,
  TsCallResolver,
} from "../edge-builder.js";
import type { ConfigEdge } from "../configEdges.js";
import type { FileMetadata } from "../fileScanner.js";
import type { IndexProgress } from "../indexer.js";
import type { ParserWorkerPool } from "../workerPool.js";
import type { SymbolWithNodeId } from "../worker.js";
import type { ExtractedCall } from "../treesitter/extractCalls.js";
import type { ExtractedImport } from "../treesitter/extractImports.js";
import type * as ladybugDb from "../../db/ladybug-queries.js";
import type { SymbolMapFileUpdate } from "../symbol-map-cache.js";

// ── ProcessFile params & result ─────────────────────────────────────

export interface ProcessFileParams {
  repoId: string;
  repoRoot: string;
  fileMeta: FileMetadata;
  languages: string[];
  mode: "full" | "incremental";
  existingFile?: {
    fileId: string;
    contentHash: string;
    lastIndexedAt: string | null;
  };
  symbolIndex?: SymbolIndex;
  pendingCallEdges?: PendingCallEdge[];
  createdCallEdges?: Set<string>;
  tsResolver?: TsCallResolver | null;
  config?: RepoConfig;
  allSymbolsByName?: Map<string, ladybugDb.SymbolLiteRow[]>;
  onProgress?: (progress: IndexProgress) => void;
  workerPool?: ParserWorkerPool | null;
  skipCallResolution?: boolean;
  globalNameToSymbolIds?: Map<string, string[]>;
  globalPreferredSymbolId?: Map<string, string>;
  supportsPass2FilePath?: (relPath: string) => boolean;
}

export interface ProcessFileResult {
  symbolsIndexed: number;
  edgesCreated: number;
  changed: boolean;
  configEdges: ConfigEdge[];
  pass2HintPaths: string[];
  symbolMapFileUpdate?: SymbolMapFileUpdate;
}

// ── Early-exit phase output ─────────────────────────────────────────

export interface FileReadResult {
  filePath: string;
  content: string;
  contentHash: string;
  ext: string;
  extWithDot: string;
  relPath: string;
  fileId: string;
}

export type EarlyExitOutcome =
  | { status: "skip"; result: ProcessFileResult }
  | {
      status: "ready";
      data: FileReadResult;
      adapter: NonNullable<ReturnType<typeof import("../adapter/registry.js").getAdapterForExtension>>;
    };

// ── Parse phase output ──────────────────────────────────────────────

export interface ParseResult {
  symbolsWithNodeIds: SymbolWithNodeId[];
  imports: ExtractedImport[];
  calls: ExtractedCall[];
  tree: import("tree-sitter").Tree | null;
}

export type ParseOutcome =
  | { status: "skip"; result: ProcessFileResult }
  | { status: "parsed"; data: ParseResult };

// ── Symbol detail (shared between TS and Rust paths) ────────────────

export type SymbolKindLiteral =
  | "function"
  | "class"
  | "interface"
  | "type"
  | "method"
  | "constructor"
  | "variable"
  | "module";

export type SignatureLike = {
  params: Array<{ name: string; type?: string }>;
  returns?: string;
  generics?: string[];
};

export interface SymbolDetail {
  extractedSymbol: {
    nodeId: string;
    kind: SymbolKindLiteral;
    name: string;
    exported: boolean;
    range: {
      startLine: number;
      startCol: number;
      endLine: number;
      endCol: number;
    };
    signature?: SignatureLike;
    visibility?: "public" | "private" | "protected" | "internal";
  };
  astFingerprint: string;
  symbolId: string;
  /** Rust-native metadata (only present on Rust path) */
  nativeSummary?: string;
  nativeInvariantsJson?: string;
  nativeSideEffectsJson?: string;
  nativeRoleTagsJson?: string;
  nativeSearchText?: string;
}

// ── Build-rows phase params & result ────────────────────────────────

export interface BuildRowsParams {
  repoId: string;
  relPath: string;
  fileId: string;
  filePath: string;
  content: string;
  ext: string;
  languages: string[];
  symbolDetails: SymbolDetail[];
  nodeIdToSymbolId: Map<string, string>;
  nameToSymbolIds: Map<string, string[]>;
  existingSymbolsById: Map<string, SymbolRow>;
  importResolution: {
    targets: Array<{ symbolId: string; provenance: string }>;
    importedNameToSymbolIds: Map<string, string[]>;
    namespaceImports: Map<string, Map<string, string>>;
  };
  calls: ExtractedCall[];
  edgeSourceNodeIds: Set<string>;
  languageId: string;
  symbolIndex?: SymbolIndex;
  pendingCallEdges?: PendingCallEdge[];
  createdCallEdges?: Set<string>;
  tsResolver?: TsCallResolver | null;
  skipCallResolution?: boolean;
  globalNameToSymbolIds?: Map<string, string[]>;
  globalPreferredSymbolId?: Map<string, string>;
  adapter?: import("../adapter/LanguageAdapter.js").LanguageAdapter | null;
}

export interface BuildRowsResult {
  symbolsToUpsert: SymbolRow[];
  fileSymbols: SymbolRow[];
  edgesToInsert: EdgeRow[];
  symbolReferences: SymbolReferenceRow[];
  edgesCreated: number;
}
