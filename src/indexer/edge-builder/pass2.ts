import { dirname, join } from "path";
import { platform } from "process";

import { getDb } from "../../db/db.js";
import {
  createEdgeTransaction,
  deleteOutgoingCallEdgesBySymbol,
  getEdgesByRepo,
  getFile,
  getFileByRepoPath,
  getFilesByRepo,
  getSymbol,
  getSymbolsByFile,
  getSymbolsByFileLite,
  getSymbolsByRepo,
} from "../../db/queries.js";
import type { EdgeRow, FileRow, SymbolKind, SymbolRow } from "../../db/schema.js";
import { readFileAsync } from "../../util/asyncFs.js";
import { normalizePath } from "../../util/paths.js";
import { logger } from "../../util/logger.js";
import { getAdapterForExtension } from "../adapter/registry.js";
import type { FileMetadata } from "../fileScanner.js";

import { resolveCallTarget } from "./call-resolution.js";
import { resolveImportTargets } from "./import-resolution.js";
import { resolveSymbolIdFromIndex } from "./symbol-index.js";
import { incRecord, isTsCallResolutionFile, pushTelemetrySample } from "./telemetry.js";
import type { CallResolutionTelemetry } from "./telemetry.js";
import type { SymbolIndex, TsCallResolver } from "./types.js";

function resolvePass2Targets(params: {
  repoId: string;
  mode: "full" | "incremental";
  tsFiles: FileMetadata[];
  changedTsFilePaths: Set<string>;
}): FileMetadata[] {
  const { repoId, mode, tsFiles, changedTsFilePaths } = params;
  if (mode === "full") {
    return tsFiles;
  }
  if (changedTsFilePaths.size === 0) {
    return [];
  }

  const tsFilesByPath = new Map(tsFiles.map((file) => [file.path, file]));
  const targetPaths = new Set<string>(changedTsFilePaths);
  const changedSymbolIds = new Set<string>();

  for (const changedPath of changedTsFilePaths) {
    const file = getFileByRepoPath(repoId, changedPath);
    if (!file) continue;
    const symbols = getSymbolsByFile(file.file_id);
    for (const symbol of symbols) {
      changedSymbolIds.add(symbol.symbol_id);
    }
  }

  if (changedSymbolIds.size === 0) {
    return Array.from(targetPaths)
      .map((path) => tsFilesByPath.get(path))
      .filter((file): file is FileMetadata => Boolean(file));
  }

  const importEdges = getEdgesByRepo(repoId).filter((edge) => edge.type === "import");
  for (const edge of importEdges) {
    if (!changedSymbolIds.has(edge.to_symbol_id)) continue;
    const fromSymbol = getSymbol(edge.from_symbol_id);
    if (!fromSymbol) continue;
    const fromFile = getFile(fromSymbol.file_id);
    if (!fromFile) continue;
    if (!isTsCallResolutionFile(fromFile.rel_path)) continue;
    targetPaths.add(fromFile.rel_path);
  }

  return Array.from(targetPaths)
    .map((path) => tsFilesByPath.get(path))
    .filter((file): file is FileMetadata => Boolean(file));
}

async function resolveTsCallEdgesPass2(params: {
  repoId: string;
  repoRoot: string;
  fileMeta: FileMetadata;
  symbolIndex: SymbolIndex;
  tsResolver: TsCallResolver | null;
  languages: string[];
  createdCallEdges: Set<string>;
  globalNameToSymbolIds?: Map<string, string[]>;
  telemetry?: CallResolutionTelemetry;
}): Promise<number> {
  const {
    repoId,
    repoRoot,
    fileMeta,
    symbolIndex,
    tsResolver,
    languages,
    createdCallEdges,
    globalNameToSymbolIds,
    telemetry,
  } = params;
  if (!isTsCallResolutionFile(fileMeta.path)) {
    return 0;
  }

  try {
    const filePath = join(repoRoot, fileMeta.path);
    const content = await readFileAsync(filePath, "utf-8");
    const ext = fileMeta.path.split(".").pop() || "";
    const extWithDot = `.${ext}`;
    const adapter = getAdapterForExtension(extWithDot);
    if (!adapter) {
      return 0;
    }

    const tree = adapter.parse(content, filePath);
    if (!tree) {
      return 0;
    }

    const extractedSymbols = adapter.extractSymbols(tree, content, filePath);
    if (telemetry) {
      telemetry.pass2SymbolMapping.extractedSymbols += extractedSymbols.length;
    }
    const symbolsWithNodeIds = extractedSymbols.map((symbol) => ({
      nodeId: symbol.nodeId,
      kind: symbol.kind,
      name: symbol.name,
      exported: symbol.exported,
      range: symbol.range,
      signature: symbol.signature,
      visibility: symbol.visibility,
    }));
    const imports = adapter.extractImports(tree, content, filePath);
    const calls = adapter.extractCalls(
      tree,
      content,
      filePath,
      symbolsWithNodeIds as any,
    );

    const fileRecord = getFileByRepoPath(repoId, fileMeta.path);
    if (!fileRecord) {
      return 0;
    }
    const existingSymbols = getSymbolsByFile(fileRecord.file_id);
    if (telemetry) {
      telemetry.pass2SymbolMapping.existingSymbols += existingSymbols.length;
    }

    if (existingSymbols.length === 0) {
      if (telemetry) telemetry.pass2FilesNoExistingSymbols++;
      if (telemetry) {
        pushTelemetrySample(telemetry.samples.noMappedSymbols, fileMeta.path);
      }
      return 0;
    }

    const toFullKey = (
        kind: SymbolKind,
        name: string,
        range: {
          startLine: number;
          startCol: number;
          endLine: number;
          endCol: number;
        },
      ): string =>
        `${kind}:${name}:${range.startLine}:${range.startCol}:${range.endLine}:${range.endCol}`;

      const toStartKey = (
        kind: SymbolKind,
        name: string,
        range: {
          startLine: number;
          startCol: number;
        },
      ): string => `${kind}:${name}:${range.startLine}:${range.startCol}`;

      const toStartLineKey = (
        kind: SymbolKind,
        name: string,
        range: {
          startLine: number;
        },
      ): string => `${kind}:${name}:${range.startLine}`;

      const toNameKindKey = (kind: SymbolKind, name: string): string =>
        `${kind}:${name}`;

      const symbolIdByFullKey = new Map<string, string>();
      const symbolsByStartKey = new Map<string, SymbolRow[]>();
      const symbolsByStartLineKey = new Map<string, SymbolRow[]>();
      const symbolsByNameKindKey = new Map<string, SymbolRow[]>();

      const pushSymbol = (
        map: Map<string, SymbolRow[]>,
        key: string,
        symbol: SymbolRow,
      ): void => {
        const existing = map.get(key) ?? [];
        existing.push(symbol);
        map.set(key, existing);
      };

      for (const symbol of existingSymbols) {
        const range = {
          startLine: symbol.range_start_line,
          startCol: symbol.range_start_col,
          endLine: symbol.range_end_line,
          endCol: symbol.range_end_col,
        };

        symbolIdByFullKey.set(
          toFullKey(symbol.kind, symbol.name, range),
          symbol.symbol_id,
        );
        pushSymbol(
          symbolsByStartKey,
          toStartKey(symbol.kind, symbol.name, range),
          symbol,
        );
        pushSymbol(
          symbolsByStartLineKey,
          toStartLineKey(symbol.kind, symbol.name, range),
          symbol,
        );
        pushSymbol(
          symbolsByNameKindKey,
          toNameKindKey(symbol.kind, symbol.name),
          symbol,
        );
      }

      const mapExtractedSymbolId = (
        extractedSymbol: (typeof symbolsWithNodeIds)[number],
      ): { symbolId: string; strategy: string } | null => {
        const fullMatch = symbolIdByFullKey.get(
          toFullKey(
            extractedSymbol.kind,
            extractedSymbol.name,
            extractedSymbol.range,
          ),
        );
        if (fullMatch) {
          return { symbolId: fullMatch, strategy: "full_range" };
        }

        const startCandidates = symbolsByStartKey.get(
          toStartKey(
            extractedSymbol.kind,
            extractedSymbol.name,
            extractedSymbol.range,
          ),
        );
        if (startCandidates && startCandidates.length === 1) {
          return {
            symbolId: startCandidates[0].symbol_id,
            strategy: "start_only",
          };
        }

        const startLineCandidates = symbolsByStartLineKey.get(
          toStartLineKey(
            extractedSymbol.kind,
            extractedSymbol.name,
            extractedSymbol.range,
          ),
        );
        if (startLineCandidates && startLineCandidates.length === 1) {
          return {
            symbolId: startLineCandidates[0].symbol_id,
            strategy: "start_line",
          };
        }

        const nameKindCandidates = symbolsByNameKindKey.get(
          toNameKindKey(extractedSymbol.kind, extractedSymbol.name),
        );
        if (nameKindCandidates && nameKindCandidates.length === 1) {
          return {
            symbolId: nameKindCandidates[0].symbol_id,
            strategy: "name_kind_unique",
          };
        }

        return null;
      };

      const filteredSymbolDetails = symbolsWithNodeIds
        .map((extractedSymbol) => {
          const mapped = mapExtractedSymbolId(extractedSymbol);
          if (!mapped) {
            if (telemetry) telemetry.pass2SymbolMapping.unmappedSymbols++;
            if (telemetry) {
              pushTelemetrySample(telemetry.samples.mappingFailures, {
                file: fileMeta.path,
                kind: extractedSymbol.kind,
                name: extractedSymbol.name,
                startLine: extractedSymbol.range.startLine,
                startCol: extractedSymbol.range.startCol,
              });
            }
            return null;
          }

          if (telemetry) telemetry.pass2SymbolMapping.mappedSymbols++;
          if (telemetry) {
            incRecord(telemetry.pass2SymbolMapping.strategyCounts, mapped.strategy);
          }

          return {
            extractedSymbol,
            symbolId: mapped.symbolId,
          };
        })
        .filter(
          (
            detail,
          ): detail is {
            extractedSymbol: (typeof symbolsWithNodeIds)[number];
            symbolId: string;
          } => Boolean(detail),
        );

      if (filteredSymbolDetails.length === 0) {
        if (telemetry) telemetry.pass2FilesNoMappedSymbols++;
        if (telemetry) {
          pushTelemetrySample(telemetry.samples.noMappedSymbols, fileMeta.path);
        }
        return 0;
      }

    for (const detail of filteredSymbolDetails) {
      deleteOutgoingCallEdgesBySymbol(detail.symbolId);
      for (const edgeKey of Array.from(createdCallEdges)) {
        if (edgeKey.startsWith(`${detail.symbolId}->`)) {
          createdCallEdges.delete(edgeKey);
        }
      }
    }

    const nodeIdToSymbolId = new Map<string, string>();
    const nameToSymbolIds = new Map<string, string[]>();
    for (const detail of filteredSymbolDetails) {
      nodeIdToSymbolId.set(detail.extractedSymbol.nodeId, detail.symbolId);
      const existing = nameToSymbolIds.get(detail.extractedSymbol.name) ?? [];
      existing.push(detail.symbolId);
      nameToSymbolIds.set(detail.extractedSymbol.name, existing);
    }

    const extensions = languages.map((lang) => `.${lang}`);
    const importResolution = await resolveImportTargets(
      repoId,
      repoRoot,
      fileMeta.path,
      imports,
      extensions,
      adapter.languageId,
      content,
    );

    let createdEdges = 0;
    for (const detail of filteredSymbolDetails) {
      for (const call of calls) {
        if (call.callerNodeId !== detail.extractedSymbol.nodeId) {
          continue;
        }
        if (telemetry) telemetry.adapterCalls.total++;
        const resolved = resolveCallTarget(
          call,
          nodeIdToSymbolId,
          nameToSymbolIds,
          importResolution.importedNameToSymbolIds,
          importResolution.namespaceImports,
          adapter,
          globalNameToSymbolIds,
        );
        if (!resolved) {
          if (telemetry) telemetry.adapterCalls.returnedNull++;
          continue;
        }

        if (resolved.isResolved && resolved.symbolId) {
          const edgeKey = `${detail.symbolId}->${resolved.symbolId}`;
          if (createdCallEdges.has(edgeKey)) {
            if (telemetry) telemetry.adapterCalls.duplicates++;
            continue;
          }
          createEdgeTransaction({
            repo_id: repoId,
            from_symbol_id: detail.symbolId,
            to_symbol_id: resolved.symbolId,
            type: "call",
            weight: 1.0,
            confidence: resolved.confidence,
            resolution_strategy: resolved.strategy,
            provenance: `call:${call.calleeIdentifier}`,
            created_at: new Date().toISOString(),
          });
          createdCallEdges.add(edgeKey);
          createdEdges++;
          if (telemetry) telemetry.adapterCalls.resolved++;
          if (telemetry) {
            incRecord(
              telemetry.adapterCalls.resolvedByStrategy,
              resolved.strategy ?? "unknown",
            );
          }
        } else if (resolved.targetName) {
          // Skip built-in method/constructor calls that can never resolve
          if (isBuiltinCall(resolved.targetName)) {
            if (telemetry) telemetry.adapterCalls.skippedBuiltin++;
            continue;
          }
          const unresolvedTargetId = `unresolved:call:${resolved.targetName}`;
          const edgeKey = `${detail.symbolId}->${unresolvedTargetId}`;
          if (createdCallEdges.has(edgeKey)) {
            if (telemetry) telemetry.adapterCalls.duplicates++;
            continue;
          }
          createEdgeTransaction({
            repo_id: repoId,
            from_symbol_id: detail.symbolId,
            to_symbol_id: unresolvedTargetId,
            type: "call",
            weight: 0.5,
            confidence: resolved.confidence,
            resolution_strategy: "unresolved",
            provenance: `unresolved-call:${call.calleeIdentifier}${resolved.candidateCount ? `:candidates=${resolved.candidateCount}` : ""}`,
            created_at: new Date().toISOString(),
          });
          createdCallEdges.add(edgeKey);
          createdEdges++;
          if (telemetry) telemetry.adapterCalls.unresolved++;
        }
      }
    }

    if (tsResolver) {
      const tsCalls = tsResolver.getResolvedCalls(fileMeta.path);
      if (telemetry) telemetry.tsResolverCalls.total += tsCalls.length;
      for (const tsCall of tsCalls) {
        const callerNodeId = findEnclosingSymbolByRange(tsCall.caller, filteredSymbolDetails);
        if (!callerNodeId) {
          if (telemetry) telemetry.tsResolverCalls.skippedNoCaller++;
          continue;
        }
        const fromSymbolId = nodeIdToSymbolId.get(callerNodeId);
        if (!fromSymbolId) {
          if (telemetry) telemetry.tsResolverCalls.skippedNoFromSymbol++;
          continue;
        }
        const toSymbolId = resolveSymbolIdFromIndex(
          symbolIndex,
          repoId,
          tsCall.callee.filePath,
          tsCall.callee.name,
          tsCall.callee.kind,
          adapter.languageId,
        );
        if (!toSymbolId) {
          if (telemetry) telemetry.tsResolverCalls.skippedNoToSymbol++;
          if (telemetry) {
            pushTelemetrySample(telemetry.samples.tsNoToSymbol, {
              file: fileMeta.path,
              calleeFile: tsCall.callee.filePath,
              calleeName: tsCall.callee.name,
              calleeKind: tsCall.callee.kind,
            });
          }
          continue;
        }
        const edgeKey = `${fromSymbolId}->${toSymbolId}`;
        if (createdCallEdges.has(edgeKey)) {
          if (telemetry) telemetry.tsResolverCalls.skippedDuplicate++;
          continue;
        }
        createEdgeTransaction({
          repo_id: repoId,
          from_symbol_id: fromSymbolId,
          to_symbol_id: toSymbolId,
          type: "call",
          weight: 1.0,
          confidence: tsCall.confidence ?? 1.0,
          resolution_strategy: "exact",
          provenance: `ts-call:${tsCall.callee.name}`,
          created_at: new Date().toISOString(),
        });
        createdCallEdges.add(edgeKey);
        createdEdges++;
        if (telemetry) telemetry.tsResolverCalls.edgesCreated++;
      }
    }

    return createdEdges;
  } catch (error) {
    logger.warn(
      `Pass 2 call resolution failed for ${fileMeta.path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return 0;
  }
}

// Built-in JS/TS method names that can never resolve to repo symbols.
// Filtering these from unresolved edges reduces totalCallEdges denominator.
const BUILTIN_IDENTIFIERS = new Set([
  // Array prototype
  "push", "pop", "shift", "unshift", "splice", "slice", "concat",
  "map", "filter", "reduce", "reduceRight", "find", "findIndex",
  "some", "every", "includes", "indexOf", "lastIndexOf",
  "sort", "reverse", "flat", "flatMap", "fill", "copyWithin",
  "forEach", "entries", "keys", "values", "join", "at",
  // String prototype
  "split", "trim", "trimStart", "trimEnd", "replace", "replaceAll",
  "startsWith", "endsWith",
  "toLowerCase", "toUpperCase", "toLocaleLowerCase", "toLocaleUpperCase",
  "match", "matchAll", "search", "padStart", "padEnd",
  "charAt", "charCodeAt", "codePointAt", "repeat", "substring",
  "localeCompare",
  // Object static
  "assign", "freeze", "defineProperty",
  "getOwnPropertyNames", "getPrototypeOf", "create", "fromEntries",
  // Math static
  "floor", "ceil", "round", "max", "min", "abs", "sqrt", "pow", "random", "log",
  // JSON
  "stringify", "parse",
  // Number/Date
  "toFixed", "toPrecision", "toISOString", "getTime", "toLocaleString",
  "parseInt", "parseFloat", "isNaN", "isFinite", "isInteger",
  // Promise
  "then", "catch", "finally",
  // Map/Set/WeakMap/WeakSet instance
  "has", "get", "set", "delete", "clear", "add",
  // Console
  "warn", "error", "info", "debug", "trace",
  // RegExp
  "test", "exec",
  // Node.js fs/path/url/events
  "readFileSync", "writeFileSync", "existsSync", "mkdirSync",
  "readFile", "writeFile", "readdir", "readdirSync", "stat", "statSync",
  "resolve", "dirname", "basename", "extname", "relative", "isAbsolute",
  "fileURLToPath", "pathToFileURL",
  "on", "off", "once", "emit", "removeListener", "removeAllListeners",
  // process
  "exit", "cwd", "env",
  // SQLite/DB
  "prepare", "run", "all", "transaction", "close",
  // Zod schema builder methods
  "object", "string", "number", "boolean", "array", "enum", "optional",
  "nullable", "default", "describe", "int", "transform", "refine",
  "union", "intersection", "literal", "tuple", "record", "lazy",
  "coerce", "safeParse", "parseAsync", "passthrough", "strict",
  "extend", "merge", "pick", "omit", "partial", "required", "shape",
  "min", "max", "length", "email", "url", "uuid", "regex",
  // tree-sitter AST node methods
  "childForFieldName", "children", "namedChildren", "childCount",
  "namedChild", "child", "firstChild", "lastChild", "nextSibling",
  "previousSibling", "parent", "descendantsOfType", "walk",
  "startPosition", "endPosition",
  // Rust standard library
  "to_string", "unwrap", "unwrap_or", "unwrap_or_else",
  "expect", "is_some", "is_none", "is_ok", "is_err",
  "ok", "err", "as_ref", "as_mut", "as_str", "as_bytes",
  "collect", "iter", "into_iter", "len", "is_empty",
  "contains", "clone", "to_owned", "into", "from",
  "fmt", "display", "write_str", "write_fmt",
  // Testing frameworks
  "it", "beforeEach", "afterEach", "beforeAll", "afterAll",
  // Global functions
  "encodeURIComponent", "decodeURIComponent", "encodeURI", "decodeURI",
  "setTimeout", "clearTimeout", "setInterval", "clearInterval",
  "requestAnimationFrame", "cancelAnimationFrame",
  "atob", "btoa", "fetch",
  // Misc
  "toString", "valueOf", "toJSON", "iterator",
  "isArray", "write", "update", "next", "done", "send", "end",
]);

// Built-in constructors that will never resolve to repo symbols
const BUILTIN_CONSTRUCTORS = new Set([
  "Map", "Set", "WeakMap", "WeakSet", "Error", "TypeError", "RangeError",
  "SyntaxError", "ReferenceError", "Date", "RegExp", "Promise",
  "Array", "Object", "Number", "String", "Boolean", "Symbol",
  "Int8Array", "Uint8Array", "Float32Array", "Float64Array",
  "ArrayBuffer", "SharedArrayBuffer", "DataView", "Proxy", "Reflect",
  "URL", "URLSearchParams", "AbortController", "AbortSignal",
  "TextEncoder", "TextDecoder", "ReadableStream", "WritableStream",
  "Buffer", "EventEmitter", "Headers", "Request", "Response", "FormData",
  // Rust standard types (extracted as constructors)
  "Vec", "HashMap", "HashSet", "BTreeMap", "BTreeSet",
  "Some", "None", "Ok", "Err", "Box", "Rc", "Arc", "Cell", "RefCell",
  "Mutex", "RwLock", "PathBuf", "OsString", "CString",
]);

/** Check if an unresolved call target is a built-in that should be skipped. */
function isBuiltinCall(targetName: string): boolean {
  if (BUILTIN_IDENTIFIERS.has(targetName) || BUILTIN_CONSTRUCTORS.has(targetName)) {
    return true;
  }
  // Handle compound names like "Vec::new", "HashMap::new", "Some(x)"
  if (targetName.includes(":")) {
    const parts = targetName.split(":");
    if (parts.some(p => BUILTIN_CONSTRUCTORS.has(p) || BUILTIN_IDENTIFIERS.has(p))) {
      return true;
    }
  }
  return false;
}

function cleanupUnresolvedEdges(repoId: string): void {
  const allEdges = getEdgesByRepo(repoId);
  const unresolvedEdges = allEdges.filter((edge: EdgeRow) =>
    edge.to_symbol_id.startsWith("unresolved:"),
  );

  const database = getDb();
  const deleteEdgeStmt = database.prepare(
    "DELETE FROM edges WHERE from_symbol_id = ? AND to_symbol_id = ?",
  );

  // IE-K.3: Node.js built-ins to skip
  const nodeBuiltins = new Set([
    "assert",
    "async_hooks",
    "buffer",
    "child_process",
    "cluster",
    "console",
    "crypto",
    "dgram",
    "dns",
    "domain",
    "events",
    "fs",
    "http",
    "http2",
    "https",
    "inspector",
    "module",
    "net",
    "os",
    "path",
    "perf_hooks",
    "process",
    "punycode",
    "querystring",
    "readline",
    "repl",
    "stream",
    "string_decoder",
    "sys",
    "timers",
    "tls",
    "trace_events",
    "tty",
    "url",
    "util",
    "v8",
    "vm",
    "worker_threads",
    "zlib",
  ]);

  // IE-K.3: Check if unresolved edge points to external package
  const isExternalPackage = (target: string, edgeType: string): boolean => {
    // Import edges: unresolved:package:name (e.g., unresolved:tree-sitter:Parser)
    if (edgeType === "import") {
      const parts = target.split(":");
      if (parts.length >= 3) {
        const packagePath = parts[1];
        // Skip if not relative path (i.e., external package)
        if (
          !packagePath.startsWith("./") &&
          !packagePath.startsWith("../") &&
          !packagePath.startsWith("/")
        ) {
          return true;
        }
      }
    }

    // Call edges: unresolved:call:name or unresolved:call:package:name
    // Check if name matches known patterns (Node.js built-ins or external packages)
    if (target.startsWith("unresolved:call:")) {
      const namePart = target.slice("unresolved:call:".length);
      // Skip if name is a Node.js builtin
      if (nodeBuiltins.has(namePart)) {
        return true;
      }
      // Skip built-in JS/TS method calls that can never resolve to repo symbols
      if (BUILTIN_IDENTIFIERS.has(namePart)) {
        return true;
      }
      // Skip built-in constructor calls
      if (BUILTIN_CONSTRUCTORS.has(namePart)) {
        return true;
      }
      // Skip if name contains package-like pattern (e.g., "tree-sitter:Parser")
      if (
        namePart.includes(":") &&
        !namePart.startsWith("./") &&
        !namePart.startsWith("../")
      ) {
        return true;
      }
    }

    return false;
  };

  // Cache repo symbols for call edge resolution
  let repoSymbols: SymbolRow[] | null = null;
  const getRepoSymbolsCached = () => {
    if (!repoSymbols) {
      repoSymbols = getSymbolsByRepo(repoId);
    }
    return repoSymbols;
  };

  // Cache symbol-to-file mapping
  const symbolToFile = new Map<string, FileRow | null>();
  const getSymbolFile = (symbolId: string): FileRow | null => {
    if (symbolToFile.has(symbolId)) {
      return symbolToFile.get(symbolId) ?? null;
    }
    const symbol = getSymbol(symbolId);
    if (!symbol) {
      symbolToFile.set(symbolId, null);
      return null;
    }
    const file = getFile(symbol.file_id);
    symbolToFile.set(symbolId, file ?? null);
    return file ?? null;
  };

  for (const edge of unresolvedEdges) {
    const target = edge.to_symbol_id;

    // Delete built-in JS/TS method and constructor call edges that can never resolve.
    // These inflate the totalCallEdges denominator without providing value.
    if (target.startsWith("unresolved:call:")) {
      const namePart = target.slice("unresolved:call:".length);
      if (isBuiltinCall(namePart)) {
        deleteEdgeStmt.run(edge.from_symbol_id, edge.to_symbol_id);
        continue;
      }
    }

    // IE-K.3: External package edges - delete call edges (they inflate the
    // denominator), skip import edges (they represent real dependencies).
    if (isExternalPackage(target, edge.type)) {
      if (edge.type === "call") {
        deleteEdgeStmt.run(edge.from_symbol_id, edge.to_symbol_id);
      }
      continue;
    }

    let matchingSymbolId: string | undefined;
    let isUniqueMatch = false;

    // Format 1: unresolved:call:functionName - simple call edge
    const callMatch = target.match(/^unresolved:call:(.+)$/);
    if (callMatch) {
      const targetName = callMatch[1];
      // Find ALL matches to determine uniqueness for confidence scoring
      const allMatches = getRepoSymbolsCached().filter((sym: SymbolRow) => {
        if (sym.name === targetName) return true;
        if (targetName.includes(":")) {
          const parts: string[] = targetName.split(":");
          return parts.some((part: string) => sym.name === part);
        }
        return false;
      });
      if (allMatches.length > 0) {
        matchingSymbolId = allMatches[0].symbol_id;
        isUniqueMatch = allMatches.length === 1;
      }
    }

    // Format 2: unresolved:path/to/file.js:symbolName - import edge with file path
    // Skip namespace imports (* as X) and star imports (*)
    if (!callMatch && !target.includes(":*")) {
      // Parse: unresolved:path:symbolName (last colon separates path from symbol)
      const lastColon = target.lastIndexOf(":");
      if (lastColon > 11) {
        // "unresolved:".length = 11
        const pathPart = target.slice(11, lastColon);
        const symbolName = target.slice(lastColon + 1);

        // Get the source file to resolve relative paths
        const sourceFile = getSymbolFile(edge.from_symbol_id);

        if (
          sourceFile &&
          (pathPart.startsWith("./") || pathPart.startsWith("../"))
        ) {
          // Resolve relative path from source file's directory
          const sourceDir = dirname(sourceFile.rel_path);
          const joinedPath = join(sourceDir, pathPart);
          const normalizedJoined = normalizePath(joinedPath);

          // Try multiple path variants for better matching
          const pathVariants: string[] = [
            // Normalized path with original extension
            normalizedJoined,
            // .js -> .ts conversion
            normalizedJoined.replace(/\.js$/, ".ts"),
            // .jsx -> .tsx conversion
            normalizedJoined.replace(/\.jsx$/, ".tsx"),
            // Try with .ts extension if no extension
            !normalizedJoined.match(/\.(js|ts|jsx|tsx)$/)
              ? `${normalizedJoined}.ts`
              : normalizedJoined,
            // Try with .js extension if no extension
            !normalizedJoined.match(/\.(js|ts|jsx|tsx)$/)
              ? `${normalizedJoined}.js`
              : normalizedJoined,
            // Try index.ts (with and without trailing slash)
            normalizedJoined.replace(/\.(js|ts|jsx|tsx)$/, "") + "/index.ts",
            // Try index.js
            normalizedJoined.replace(/\.(js|ts|jsx|tsx)$/, "") + "/index.js",
            // Try removing any extension and keeping as directory
            normalizedJoined.replace(/\.(js|ts|jsx|tsx)$/, ""),
          ];

          // Remove duplicates from variants
          const uniqueVariants = [...new Set(pathVariants)];

          for (const variant of uniqueVariants) {
            const targetFile = getFileByRepoPath(repoId, variant);
            if (targetFile) {
              // Find exported symbol by name in that file
              const fileSymbols = getSymbolsByFileLite(
                targetFile.file_id,
              ).filter((s) => s.exported === 1);
              const match = fileSymbols.find((s) => s.name === symbolName);
              if (match) {
                matchingSymbolId = match.symbol_id;
                break;
              }

              // Fallback: if single export and looking for default
              if (!matchingSymbolId && fileSymbols.length === 1) {
                matchingSymbolId = fileSymbols[0].symbol_id;
                break;
              }
            }

            // IE-K.2: Try case-insensitive matching on Windows
            if (!matchingSymbolId && platform === "win32") {
              const allFiles = getFilesByRepo(repoId);
              const caseInsensitiveMatch = allFiles.find(
                (f) => f.rel_path.toLowerCase() === variant.toLowerCase(),
              );
              if (caseInsensitiveMatch) {
                const fileSymbols = getSymbolsByFileLite(
                  caseInsensitiveMatch.file_id,
                ).filter((s) => s.exported === 1);
                const match = fileSymbols.find((s) => s.name === symbolName);
                if (match) {
                  matchingSymbolId = match.symbol_id;
                  break;
                }

                // Fallback: if single export and looking for default
                if (!matchingSymbolId && fileSymbols.length === 1) {
                  matchingSymbolId = fileSymbols[0].symbol_id;
                  break;
                }
              }
            }
          }
        } else if (!pathPart.startsWith("./") && !pathPart.startsWith("../")) {
          // Non-relative import (node_modules, etc.) - skip
          continue;
        }
      }
    }

    if (matchingSymbolId) {
      deleteEdgeStmt.run(edge.from_symbol_id, edge.to_symbol_id);

      // Set proper strategy/confidence based on match quality instead of
      // copying the original "unresolved" strategy and low confidence.
      const resolvedStrategy: "heuristic" | "exact" = callMatch
        ? "heuristic"
        : (edge.resolution_strategy === "exact" ? "exact" : "heuristic");
      const resolvedConfidence = callMatch
        ? (isUniqueMatch ? 0.9 : 0.5)
        : ((edge.confidence ?? 0) >= 0.9 ? edge.confidence! : 0.7);

      createEdgeTransaction({
        repo_id: edge.repo_id,
        from_symbol_id: edge.from_symbol_id,
        to_symbol_id: matchingSymbolId,
        type: edge.type,
        weight: edge.type === "import" ? 0.6 : 1.0,
        confidence: resolvedConfidence,
        resolution_strategy: resolvedStrategy,
        provenance: edge.provenance,
        created_at: new Date().toISOString(),
      });
    } else if (callMatch) {
      // Unresolved call edge with no matching symbol in the repo.
      // These are calls to external APIs (VS Code, D3, TypeScript compiler,
      // etc.) that will never resolve. Delete them to avoid inflating the
      // totalCallEdges denominator.
      deleteEdgeStmt.run(edge.from_symbol_id, edge.to_symbol_id);
    }
  }
}

function findEnclosingSymbolByRange(
  range: {
    startLine: number;
    startCol: number;
    endLine: number;
    endCol: number;
  },
  symbols: Array<{
    extractedSymbol: {
      nodeId: string;
      range: {
        startLine: number;
        startCol: number;
        endLine: number;
        endCol: number;
      };
    };
  }>,
): string | null {
  let bestMatch: { nodeId: string; size: number } | null = null;

  for (const detail of symbols) {
    const symRange = detail.extractedSymbol.range;
    const nodeLine = range.startLine;
    const nodeCol = range.startCol;

    if (nodeLine < symRange.startLine || nodeLine > symRange.endLine) {
      continue;
    }
    if (nodeLine === symRange.startLine && nodeCol < symRange.startCol) {
      continue;
    }
    if (nodeLine === symRange.endLine && nodeCol > symRange.endCol) {
      continue;
    }

    const size =
      symRange.endLine -
      symRange.startLine +
      (symRange.endCol - symRange.startCol);
    if (!bestMatch || size < bestMatch.size) {
      bestMatch = { nodeId: detail.extractedSymbol.nodeId, size };
    }
  }

  return bestMatch?.nodeId ?? null;
}


export {
  cleanupUnresolvedEdges,
  findEnclosingSymbolByRange,
  isBuiltinCall,
  resolvePass2Targets,
  resolveTsCallEdgesPass2,
};

