import { join } from "path";

import { getLadybugConn, withWriteConn } from "../../../db/ladybug.js";
import * as ladybugDb from "../../../db/ladybug-queries.js";
import type { SymbolRow } from "../../../db/ladybug-queries.js";
import type { SymbolKind } from "../../../domain/types.js";
import { readFileAsync } from "../../../util/asyncFs.js";
import { logger } from "../../../util/logger.js";
import { normalizePath } from "../../../util/paths.js";
import { getAdapterForExtension } from "../../adapter/registry.js";
import type { FileMetadata } from "../../fileScanner.js";
import { resolveImportTargets } from "../../edge-builder/import-resolution.js";
import { findEnclosingSymbolByRange } from "../../edge-builder/enclosing-symbol.js";
import { resolveImportCandidatePaths } from "../../import-resolution/registry.js";
import type { ExtractedImport } from "../../treesitter/extractImports.js";

import type {
  Pass2ImportCache,
  Pass2Resolver,
  Pass2ResolverContext,
  Pass2ResolverResult,
  Pass2Target,
} from "../types.js";
import { confidenceFor } from "../confidence.js";
import type { ScopeNode } from "../scope-walker.js";
import {
  bucketForResolution,
  recordPass2ResolverEdge,
  recordPass2ResolverUnresolved,
} from "../../edge-builder/telemetry.js";
import { followBarrelChain, type ReExport } from "../barrel-walker.js";
import {
  resolveDecoratorTargets,
  parsePythonReExports,
  resolveSelfMethodWithScope,
} from "./python-pass2-helpers.js";

type ExtractedSymbol = {
  nodeId: string;
  kind: SymbolKind;
  name: string;
  exported: boolean;
  range: {
    startLine: number;
    startCol: number;
    endLine: number;
    endCol: number;
  };
  decorators?: string[];
};

type ExtractedCall = {
  callerNodeId?: string;
  calleeIdentifier: string;
  isResolved: boolean;
  callType: "function" | "method" | "constructor" | "dynamic";
  calleeSymbolId?: string;
  range: {
    startLine: number;
    startCol: number;
    endLine: number;
    endCol: number;
  };
};

type FilteredSymbolDetail = {
  extractedSymbol: ExtractedSymbol;
  symbolId: string;
};

type PythonResolvedCall = {
  symbolId: string | null;
  isResolved: boolean;
  confidence: number;
  resolution: string;
  targetName?: string;
  candidateCount?: number;
};

const PYTHON_PASS2_EXTENSIONS = new Set([".py"]);

// Preserved pre-Phase-2 literal: receiver-imported-instance has no direct
// strategy in the Phase-2 confidence rubric (0.84 sits between
// receiver-type=0.85 and cross-file-name-unique=0.78). Keeping it as a
// named constant preserves byte-for-byte parity without adding a one-off
// strategy to the shared rubric.
const PYTHON_RECEIVER_IMPORTED_INSTANCE_CONFIDENCE = 0.84;

function toFullKey(
  kind: SymbolKind,
  name: string,
  range: {
    startLine: number;
    startCol: number;
    endLine: number;
    endCol: number;
  },
): string {
  return `${kind}:${name}:${range.startLine}:${range.startCol}:${range.endLine}:${range.endCol}`;
}

function toStartKey(
  kind: SymbolKind,
  name: string,
  range: { startLine: number; startCol: number },
): string {
  return `${kind}:${name}:${range.startLine}:${range.startCol}`;
}

function toStartLineKey(
  kind: SymbolKind,
  name: string,
  range: { startLine: number },
): string {
  return `${kind}:${name}:${range.startLine}`;
}

function toNameKindKey(kind: SymbolKind, name: string): string {
  return `${kind}:${name}`;
}

function pushSymbol(
  map: Map<string, SymbolRow[]>,
  key: string,
  symbol: SymbolRow,
): void {
  const existing = map.get(key) ?? [];
  existing.push(symbol);
  map.set(key, existing);
}

function mapExtractedSymbolsToExisting(
  filePath: string,
  extractedSymbols: ExtractedSymbol[],
  existingSymbols: SymbolRow[],
  telemetry?: Pass2ResolverContext["telemetry"],
): FilteredSymbolDetail[] {
  const symbolIdByFullKey = new Map<string, string>();
  const symbolsByStartKey = new Map<string, SymbolRow[]>();
  const symbolsByStartLineKey = new Map<string, SymbolRow[]>();
  const symbolsByNameKindKey = new Map<string, SymbolRow[]>();

  for (const symbol of existingSymbols) {
    const range = {
      startLine: symbol.rangeStartLine,
      startCol: symbol.rangeStartCol,
      endLine: symbol.rangeEndLine,
      endCol: symbol.rangeEndCol,
    };
    symbolIdByFullKey.set(
      toFullKey(symbol.kind as SymbolKind, symbol.name, range),
      symbol.symbolId,
    );
    pushSymbol(
      symbolsByStartKey,
      toStartKey(symbol.kind as SymbolKind, symbol.name, range),
      symbol,
    );
    pushSymbol(
      symbolsByStartLineKey,
      toStartLineKey(symbol.kind as SymbolKind, symbol.name, range),
      symbol,
    );
    pushSymbol(
      symbolsByNameKindKey,
      toNameKindKey(symbol.kind as SymbolKind, symbol.name),
      symbol,
    );
  }

  const filteredSymbolDetails = extractedSymbols
    .map((extractedSymbol) => {
      const fullMatch = symbolIdByFullKey.get(
        toFullKey(
          extractedSymbol.kind,
          extractedSymbol.name,
          extractedSymbol.range,
        ),
      );
      if (fullMatch) {
        return { extractedSymbol, symbolId: fullMatch };
      }

      const startCandidates = symbolsByStartKey.get(
        toStartKey(
          extractedSymbol.kind,
          extractedSymbol.name,
          extractedSymbol.range,
        ),
      );
      if (startCandidates && startCandidates.length === 1) {
        return { extractedSymbol, symbolId: startCandidates[0].symbolId };
      }

      const startLineCandidates = symbolsByStartLineKey.get(
        toStartLineKey(
          extractedSymbol.kind,
          extractedSymbol.name,
          extractedSymbol.range,
        ),
      );
      if (startLineCandidates && startLineCandidates.length === 1) {
        return { extractedSymbol, symbolId: startLineCandidates[0].symbolId };
      }

      const nameKindCandidates = symbolsByNameKindKey.get(
        toNameKindKey(extractedSymbol.kind, extractedSymbol.name),
      );
      if (nameKindCandidates && nameKindCandidates.length === 1) {
        return { extractedSymbol, symbolId: nameKindCandidates[0].symbolId };
      }

      return null;
    })
    .filter((detail): detail is FilteredSymbolDetail => Boolean(detail));

  if (telemetry && filteredSymbolDetails.length === 0) {
    telemetry.pass2FilesNoMappedSymbols++;
    telemetry.samples.noMappedSymbols.push(filePath);
  }

  return filteredSymbolDetails;
}

/**
 * In-memory cleanup of stale dedup keys for the symbols this file is about to
 * re-resolve. The matching SQL DELETE is deferred to `submitEdgeWrite` so the
 * dispatcher can combine deletes + inserts across an entire concurrency batch
 * into a single `withWriteConn`.
 */
function clearLocalCallDedupKeys(
  symbolIds: string[],
  createdCallEdges: Set<string>,
): void {
  if (symbolIds.length === 0) return;
  for (const symbolId of symbolIds) {
    for (const edgeKey of Array.from(createdCallEdges)) {
      if (edgeKey.startsWith(`${symbolId}->`)) {
        createdCallEdges.delete(edgeKey);
      }
    }
  }
}

function createNodeIdToSymbolId(
  filteredSymbolDetails: FilteredSymbolDetail[],
): Map<string, string> {
  const nodeIdToSymbolId = new Map<string, string>();
  for (const detail of filteredSymbolDetails) {
    nodeIdToSymbolId.set(detail.extractedSymbol.nodeId, detail.symbolId);
  }
  return nodeIdToSymbolId;
}

// Phase 2 Task 2.1.1/2.1.3: map same-file function/method/class names to
// their symbol IDs. Used by decorator-chain resolution and by the lexical
// self.method() fallback when the flat local-class index is ambiguous.
function buildLocalFunctionNameIndex(
  filteredSymbolDetails: FilteredSymbolDetail[],
): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const detail of filteredSymbolDetails) {
    const kind = detail.extractedSymbol.kind;
    if (kind !== "function" && kind !== "method" && kind !== "class") {
      continue;
    }
    const raw = detail.extractedSymbol.name;
    const bare = raw.includes(".") ? raw.slice(raw.lastIndexOf(".") + 1) : raw;
    const existing = index.get(bare) ?? [];
    if (!existing.includes(detail.symbolId)) existing.push(detail.symbolId);
    index.set(bare, existing);
  }
  return index;
}

// Phase 2 Task 2.1.3: build a class-scoped method index
// Map<classSymbolId, Map<methodName, methodSymbolId[]>>
// Used by the scope-walker fallback when `self.method()` is ambiguous
// under the flat local class method index.
function buildClassScopedMethodIndex(
  filteredSymbolDetails: FilteredSymbolDetail[],
): {
  classes: FilteredSymbolDetail[];
  methodsByClass: Map<string, Map<string, string[]>>;
} {
  const classes = filteredSymbolDetails.filter(
    (d) => d.extractedSymbol.kind === "class",
  );
  const methodsByClass = new Map<string, Map<string, string[]>>();
  for (const clazz of classes) {
    methodsByClass.set(clazz.symbolId, new Map());
  }
  for (const detail of filteredSymbolDetails) {
    if (
      detail.extractedSymbol.kind !== "function" &&
      detail.extractedSymbol.kind !== "method"
    ) {
      continue;
    }
    // Choose the smallest enclosing class (handles nested classes).
    let owner: FilteredSymbolDetail | null = null;
    let ownerSize = Number.MAX_SAFE_INTEGER;
    for (const clazz of classes) {
      if (
        !isRangeWithin(
          detail.extractedSymbol.range,
          clazz.extractedSymbol.range,
        )
      )
        continue;
      const r = clazz.extractedSymbol.range;
      const size = (r.endLine - r.startLine) * 10_000 + (r.endCol - r.startCol);
      if (size < ownerSize) {
        owner = clazz;
        ownerSize = size;
      }
    }
    if (!owner) continue;
    const raw = detail.extractedSymbol.name;
    const bare = raw.includes(".") ? raw.slice(raw.lastIndexOf(".") + 1) : raw;
    const classMap = methodsByClass.get(owner.symbolId)!;
    const existing = classMap.get(bare) ?? [];
    if (!existing.includes(detail.symbolId)) existing.push(detail.symbolId);
    classMap.set(bare, existing);
  }
  return { classes, methodsByClass };
}

function isRangeWithin(
  inner: ExtractedSymbol["range"],
  outer: ExtractedSymbol["range"],
): boolean {
  if (inner.startLine < outer.startLine || inner.endLine > outer.endLine) {
    return false;
  }
  if (inner.startLine === outer.startLine && inner.startCol < outer.startCol) {
    return false;
  }
  if (inner.endLine === outer.endLine && inner.endCol > outer.endCol) {
    return false;
  }
  return true;
}

function isSymbolRowWithin(inner: SymbolRow, outer: SymbolRow): boolean {
  if (
    inner.rangeStartLine < outer.rangeStartLine ||
    inner.rangeEndLine > outer.rangeEndLine
  ) {
    return false;
  }
  if (
    inner.rangeStartLine === outer.rangeStartLine &&
    inner.rangeStartCol < outer.rangeStartCol
  ) {
    return false;
  }
  if (
    inner.rangeEndLine === outer.rangeEndLine &&
    inner.rangeEndCol > outer.rangeEndCol
  ) {
    return false;
  }
  return true;
}

function buildLocalClassMethodIndex(
  filteredSymbolDetails: FilteredSymbolDetail[],
): Map<string, string[]> {
  const classSymbols = filteredSymbolDetails.filter(
    (detail) => detail.extractedSymbol.kind === "class",
  );
  const methodNameToSymbolIds = new Map<string, string[]>();

  for (const detail of filteredSymbolDetails) {
    if (
      detail.extractedSymbol.kind !== "function" &&
      detail.extractedSymbol.kind !== "method"
    ) {
      continue;
    }

    const isMethodInClass = classSymbols.some((classDetail) =>
      isRangeWithin(
        detail.extractedSymbol.range,
        classDetail.extractedSymbol.range,
      ),
    );
    if (!isMethodInClass) {
      continue;
    }

    // For methods with dotted names (e.g. "ClassName.methodName"),
    // use only the bare method name as the map key.
    const rawName = detail.extractedSymbol.name;
    const methodName = rawName.includes(".")
      ? rawName.slice(rawName.lastIndexOf(".") + 1)
      : rawName;
    const existing = methodNameToSymbolIds.get(methodName) ?? [];
    existing.push(detail.symbolId);
    methodNameToSymbolIds.set(methodName, existing);
  }

  return methodNameToSymbolIds;
}

function buildPythonClassMethodIndex(
  symbols: SymbolRow[],
): Map<string, Map<string, string[]>> {
  const methodsByClassSymbolId = new Map<string, Map<string, string[]>>();
  const classesByFileId = new Map<string, SymbolRow[]>();
  const functionsByFileId = new Map<string, SymbolRow[]>();

  for (const symbol of symbols) {
    if (symbol.kind === "class") {
      const existing = classesByFileId.get(symbol.fileId) ?? [];
      existing.push(symbol);
      classesByFileId.set(symbol.fileId, existing);
      continue;
    }
    if (symbol.kind === "function" || symbol.kind === "method") {
      const existing = functionsByFileId.get(symbol.fileId) ?? [];
      existing.push(symbol);
      functionsByFileId.set(symbol.fileId, existing);
    }
  }

  for (const [fileId, functions] of functionsByFileId) {
    const classes = classesByFileId.get(fileId) ?? [];
    if (classes.length === 0) {
      continue;
    }

    for (const fn of functions) {
      let ownerClass: SymbolRow | null = null;
      let ownerSize = Number.MAX_SAFE_INTEGER;

      for (const clazz of classes) {
        if (!isSymbolRowWithin(fn, clazz)) {
          continue;
        }
        const size =
          (clazz.rangeEndLine - clazz.rangeStartLine) * 10_000 +
          (clazz.rangeEndCol - clazz.rangeStartCol);
        if (size < ownerSize) {
          ownerClass = clazz;
          ownerSize = size;
        }
      }

      if (!ownerClass) {
        continue;
      }

      const methods =
        methodsByClassSymbolId.get(ownerClass.symbolId) ??
        new Map<string, string[]>();
      // For methods with dotted names (e.g. "ClassName.methodName"),
      // use only the bare method name as the map key so that
      // instance method resolution can look up by bare member name.
      const methodName = fn.name.includes(".")
        ? fn.name.slice(fn.name.lastIndexOf(".") + 1)
        : fn.name;
      const existing = methods.get(methodName) ?? [];
      existing.push(fn.symbolId);
      methods.set(methodName, existing);
      methodsByClassSymbolId.set(ownerClass.symbolId, methods);
    }
  }

  return methodsByClassSymbolId;
}

function getTextBeforeCallWithinCaller(params: {
  content: string;
  callerRange: ExtractedSymbol["range"];
  callRange: ExtractedCall["range"];
}): string {
  const { content, callerRange, callRange } = params;
  const lines = content.split(/\r?\n/);
  const startLine = Math.max(callerRange.startLine - 1, 0);
  const endLine = Math.max(callRange.startLine - 1, 0);
  const segments = lines.slice(startLine, endLine);

  if (endLine < lines.length) {
    const currentLine = lines[endLine] ?? "";
    segments.push(currentLine.slice(0, Math.max(callRange.startCol, 0)));
  }

  return segments.join("\n");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function resolveImportedInstanceMethodCall(params: {
  identifier: string;
  callRange: ExtractedCall["range"];
  callerRange: ExtractedSymbol["range"];
  content: string;
  importedNameToSymbolIds: Map<string, string[]>;
  methodsByImportedClassSymbolId: Map<string, Map<string, string[]>>;
}): PythonResolvedCall | null {
  const {
    identifier,
    callRange,
    callerRange,
    content,
    importedNameToSymbolIds,
    methodsByImportedClassSymbolId,
  } = params;
  if (!identifier.includes(".")) {
    return null;
  }

  const parts = identifier.split(".");
  const receiver = parts[0];
  const member = parts[parts.length - 1];
  if (!receiver || !member) {
    return null;
  }

  const priorCallerText = getTextBeforeCallWithinCaller({
    content,
    callerRange,
    callRange,
  });
  const assignmentPattern = new RegExp(
    `(^|\\n)\\s*${escapeRegExp(receiver)}\\s*=\\s*([A-Za-z_][A-Za-z0-9_]*)\\s*\\(`,
    "g",
  );

  let constructorName: string | null = null;
  for (const match of priorCallerText.matchAll(assignmentPattern)) {
    constructorName = match[2] ?? null;
  }
  if (!constructorName) {
    return null;
  }

  const classCandidates = importedNameToSymbolIds.get(constructorName);
  if (!classCandidates || classCandidates.length !== 1) {
    return null;
  }

  const methodCandidates = methodsByImportedClassSymbolId
    .get(classCandidates[0])
    ?.get(member);
  if (!methodCandidates || methodCandidates.length !== 1) {
    return null;
  }

  return {
    symbolId: methodCandidates[0],
    isResolved: true,
    confidence: PYTHON_RECEIVER_IMPORTED_INSTANCE_CONFIDENCE,
    resolution: "receiver-imported-instance",
  };
}

// Phase 2 Task 2.1.2: follow a barrel chain through Python __init__.py
// re-exports. Returns the resolved (file, name) if the chain is valid,
// or null if the symbol does not originate in a __init__.py barrel.
// Uses followBarrelChain from the shared walker and bounds depth via
// MAX_BARREL_DEPTH.
async function resolvePythonBarrelChain(params: {
  conn: import("kuzu").Connection;
  repoId: string;
  repoRoot: string;
  startFile: string;
  symbolName: string;
  extensions: string[];
  importCache?: Pass2ImportCache;
}): Promise<{ resolvedFile: string; resolvedName: string } | null> {
  const {
    conn,
    repoId,
    repoRoot,
    startFile,
    symbolName,
    extensions,
    importCache,
  } = params;
  const lookupFile = (relPath: string): Promise<ladybugDb.FileRow | null> => {
    const cached = importCache?.fileByRelPath.get(normalizePath(relPath));
    if (cached) return Promise.resolve(cached);
    return ladybugDb.getFileByRepoPath(conn, repoId, relPath);
  };
  // Only attempt if the start file is an __init__.py.
  if (!/__init__.(py|pyw)$/.test(startFile)) return null;
  const reExportsByFile: Record<string, ReExport[]> = {};
  // Pre-load the start file's re-exports.
  try {
    const absPath = join(repoRoot, startFile);
    const content = await readFileAsync(absPath, "utf-8");
    reExportsByFile[startFile] = parsePythonReExports(startFile, content);
  } catch {
    return null;
  }
  // Resolve function for the walker: given a target file prefix (no
  // extension), find the actual .py or __init__.py file on disk. We
  // lazily load re-exports for any __init__.py we traverse.
  const hooks = {
    getReExports: (file: string): ReExport[] => reExportsByFile[file] ?? [],
  };
  // The raw targetFile values from parsePythonReExports are path prefixes
  // without extension. Resolve them against the filesystem before asking
  // the walker to follow further. We do a single-step resolution: the
  // walker's first hop yields either a .py file (done) or another
  // __init__.py (recurse).
  // For simplicity we resolve one hop manually and return the result; a
  // full multi-hop walk would require preloading every candidate.
  const firstHop = reExportsByFile[startFile].find(
    (r) => r.exportedName === symbolName,
  );
  if (!firstHop) return null;
  // Try to resolve the raw targetFile prefix to a concrete indexed file.
  for (const ext of extensions) {
    const candidate = `${firstHop.targetFile}${ext}`;
    const file = await lookupFile(candidate);
    if (file) {
      // Direct .py hit -- done.
      return {
        resolvedFile: candidate,
        resolvedName: firstHop.targetName,
      };
    }
    const initCandidate = `${firstHop.targetFile}/__init__${ext}`;
    const initFile = await lookupFile(initCandidate);
    if (initFile) {
      // Another __init__.py -- load its re-exports and continue with
      // the shared walker.
      try {
        const content = await readFileAsync(
          join(repoRoot, initCandidate),
          "utf-8",
        );
        reExportsByFile[initCandidate] = parsePythonReExports(
          initCandidate,
          content,
        );
      } catch {
        return null;
      }
      const walked = followBarrelChain(
        firstHop.targetName,
        initCandidate,
        hooks,
      );
      if (walked) {
        return {
          resolvedFile: walked.resolvedFile,
          resolvedName: walked.resolvedName,
        };
      }
      // The single-hop walker exhausted what we preloaded. Deeper
      // multi-hop `__init__.py` chains (A/__init__.py -> B/__init__.py ->
      // C/__init__.py -> real.py) are not currently supported because we
      // would need to lazily preload every intermediate `__init__.py`
      // re-export map. Log so operators chasing low call-resolution
      // health on Python projects can see why a chain dropped.
      logger.debug(
        `python-barrel: multi-hop __init__.py chain not resolved for ` +
          `${symbolName} starting at ${startFile} (hopped through ` +
          `${initCandidate}); deeper chains require lazy preloading`,
      );
    }
  }
  return null;
}

async function resolvePythonImportMaps(params: {
  conn: import("kuzu").Connection;
  repoId: string;
  repoRoot: string;
  importerRelPath: string;
  imports: ExtractedImport[];
  extensions: string[];
  importCache?: Pass2ImportCache;
}): Promise<{
  importedNameToSymbolIds: Map<string, string[]>;
  methodsByImportedClassSymbolId: Map<string, Map<string, string[]>>;
  namespaceImports: Map<string, Map<string, string>>;
}> {
  const {
    conn,
    repoId,
    repoRoot,
    importerRelPath,
    imports,
    extensions,
    importCache,
  } = params;
  const importedNameToSymbolIds = new Map<string, string[]>();
  // Populated below from full SymbolRows fetched per imported file. The
  // import cache cannot drive this index because it stores only LiteSymbol
  // (id+name); buildPythonClassMethodIndex needs kind + range to map
  // methods to their owning classes.
  const methodsByImportedClassSymbolId = new Map<
    string,
    Map<string, string[]>
  >();
  const namespaceImports = new Map<string, Map<string, string>>();

  type LiteSymbol = { symbolId: string; name: string };

  const lookupFile = async (
    relPath: string,
  ): Promise<ladybugDb.FileRow | null> => {
    const cached = importCache?.fileByRelPath.get(normalizePath(relPath));
    if (cached) return cached;
    return ladybugDb.getFileByRepoPath(conn, repoId, relPath);
  };

  const lookupExportedSymbols = async (
    targetFile: ladybugDb.FileRow,
  ): Promise<LiteSymbol[]> => {
    const cached = importCache?.exportedSymbolsByFileId.get(targetFile.fileId);
    if (cached) return cached;
    if (importCache) {
      // Cache present but file has no exports — cache is authoritative.
      return [];
    }
    const symbols = await ladybugDb.getSymbolsByFile(conn, targetFile.fileId);
    return symbols
      .filter((symbol) => symbol.exported)
      .map((symbol) => ({ symbolId: symbol.symbolId, name: symbol.name }));
  };

  for (const imp of imports) {
    const resolvedPaths = await resolveImportCandidatePaths({
      language: "python",
      repoRoot,
      importerRelPath,
      specifier: imp.specifier,
      extensions,
    });
    if (resolvedPaths.length === 0) {
      continue;
    }

    const targetFiles: ladybugDb.FileRow[] = [];
    for (const relPath of resolvedPaths) {
      const f = await lookupFile(relPath);
      if (f) targetFiles.push(f);
    }
    if (targetFiles.length === 0) {
      continue;
    }

    const targetSymbols: LiteSymbol[] = [];
    for (const targetFile of targetFiles) {
      const lite = await lookupExportedSymbols(targetFile);
      targetSymbols.push(...lite);
    }

    // Build the dotted-method index from full SymbolRows regardless of
    // cache presence. The import cache only stores LiteSymbol (id+name); it
    // lacks the kind+range data buildPythonClassMethodIndex needs to map
    // methods to their owning classes. Without this DB query,
    // `svc.run()`-style receiver-imported-instance calls never resolve.
    {
      const fullSymbols: SymbolRow[] = [];
      for (const targetFile of targetFiles) {
        const symbols = await ladybugDb.getSymbolsByFile(
          conn,
          targetFile.fileId,
        );
        fullSymbols.push(...symbols.filter((s) => s.exported));
      }
      const importedClassMethods = buildPythonClassMethodIndex(fullSymbols);
      for (const [classSymbolId, methods] of importedClassMethods) {
        const existing =
          methodsByImportedClassSymbolId.get(classSymbolId) ??
          new Map<string, string[]>();
        for (const [methodName, symbolIds] of methods) {
          const merged = existing.get(methodName) ?? [];
          for (const symbolId of symbolIds) {
            if (!merged.includes(symbolId)) {
              merged.push(symbolId);
            }
          }
          existing.set(methodName, merged);
        }
        methodsByImportedClassSymbolId.set(classSymbolId, existing);
      }
    }

    const importedNames = new Set<string>();
    if (imp.defaultImport) {
      importedNames.add(imp.defaultImport);
    }
    for (const name of imp.imports) {
      importedNames.add(name);
    }

    for (const name of importedNames) {
      if (name.startsWith("*")) {
        continue;
      }
      let match: LiteSymbol | undefined = targetSymbols.find(
        (symbol) => symbol.name === name,
      );
      if (!match && imp.defaultImport === name && targetSymbols.length === 1) {
        match = targetSymbols[0];
      }
      // Phase 2 Task 2.1.2: if the name is not defined in any target file
      // but a target file is a package `__init__.py`, try to follow the
      // re-export chain to the real definition file.
      if (!match) {
        for (const tf of targetFiles) {
          if (!/__init__.(py|pyw)$/.test(tf.relPath)) continue;
          const walked = await resolvePythonBarrelChain({
            conn,
            repoId,
            repoRoot,
            startFile: tf.relPath,
            symbolName: name,
            extensions,
            importCache,
          });
          if (!walked) continue;
          const resolvedFileRow = await lookupFile(walked.resolvedFile);
          if (!resolvedFileRow) continue;
          const syms = await lookupExportedSymbols(resolvedFileRow);
          const found = syms.find((sym) => sym.name === walked.resolvedName);
          if (found) {
            match = found;
            break;
          }
        }
      }
      if (!match) {
        continue;
      }
      const existing = importedNameToSymbolIds.get(name) ?? [];
      if (!existing.includes(match.symbolId)) {
        existing.push(match.symbolId);
      }
      importedNameToSymbolIds.set(name, existing);
    }

    if (imp.namespaceImport) {
      const namespaceMap =
        namespaceImports.get(imp.namespaceImport) ?? new Map<string, string>();
      for (const symbol of targetSymbols) {
        namespaceMap.set(symbol.name, symbol.symbolId);
      }
      namespaceImports.set(imp.namespaceImport, namespaceMap);
    }
  }

  return {
    importedNameToSymbolIds,
    methodsByImportedClassSymbolId,
    namespaceImports,
  };
}

function mergeImportedNameMaps(
  primary: Map<string, string[]>,
  secondary: Map<string, string[]>,
): Map<string, string[]> {
  const merged = new Map<string, string[]>();
  for (const [name, ids] of primary) {
    merged.set(name, [...ids]);
  }
  for (const [name, ids] of secondary) {
    const existing = merged.get(name) ?? [];
    for (const symbolId of ids) {
      if (!existing.includes(symbolId)) {
        existing.push(symbolId);
      }
    }
    merged.set(name, existing);
  }
  return merged;
}

function mergeNamespaceImports(
  primary: Map<string, Map<string, string>>,
  secondary: Map<string, Map<string, string>>,
): Map<string, Map<string, string>> {
  const merged = new Map<string, Map<string, string>>();
  for (const [namespace, symbols] of primary) {
    merged.set(namespace, new Map(symbols));
  }
  for (const [namespace, symbols] of secondary) {
    const existing = merged.get(namespace) ?? new Map<string, string>();
    for (const [name, symbolId] of symbols) {
      existing.set(name, symbolId);
    }
    merged.set(namespace, existing);
  }
  return merged;
}

function resolvePythonPass2CallTarget(params: {
  call: ExtractedCall;
  callerRange: ExtractedSymbol["range"];
  content: string;
  nodeIdToSymbolId: Map<string, string>;
  importedNameToSymbolIds: Map<string, string[]>;
  namespaceImports: Map<string, Map<string, string>>;
  localClassMethodNameToSymbolIds: Map<string, string[]>;
  methodsByImportedClassSymbolId: Map<string, Map<string, string[]>>;
  treeRoot?: ScopeNode | null;
  classScopedMethods?: {
    classes: FilteredSymbolDetail[];
    methodsByClass: Map<string, Map<string, string[]>>;
  };
}): PythonResolvedCall | null {
  const {
    call,
    callerRange,
    content,
    nodeIdToSymbolId,
    importedNameToSymbolIds,
    namespaceImports,
    localClassMethodNameToSymbolIds,
    methodsByImportedClassSymbolId,
    treeRoot,
    classScopedMethods,
  } = params;

  if (call.calleeSymbolId && nodeIdToSymbolId.has(call.calleeSymbolId)) {
    return {
      symbolId: nodeIdToSymbolId.get(call.calleeSymbolId) ?? null,
      isResolved: true,
      confidence: confidenceFor("package-qualified"),
      resolution: "same-file",
    };
  }

  const identifier = call.calleeIdentifier.replace(/^new\s+/, "").trim();
  if (!identifier) {
    return null;
  }

  const importedCandidates = importedNameToSymbolIds.get(identifier);
  if (importedCandidates && importedCandidates.length === 1) {
    return {
      symbolId: importedCandidates[0],
      isResolved: true,
      confidence: confidenceFor("import-direct"),
      resolution: "import-matched",
    };
  }

  if (identifier.includes(".")) {
    const parts = identifier.split(".");
    const prefix = parts[0];
    const member = parts[parts.length - 1];

    const namespace = namespaceImports.get(prefix);
    if (namespace?.has(member)) {
      return {
        symbolId: namespace.get(member) ?? null,
        isResolved: true,
        confidence: confidenceFor("import-direct"),
        resolution: "namespace-import",
      };
    }

    if (prefix === "self" || prefix === "cls") {
      const classMethodCandidates = localClassMethodNameToSymbolIds.get(member);
      if (classMethodCandidates && classMethodCandidates.length === 1) {
        return {
          symbolId: classMethodCandidates[0],
          isResolved: true,
          confidence: confidenceFor("receiver-type"),
          resolution: "receiver-self",
        };
      }
      // Phase 2 Task 2.1.3: flat index is ambiguous -- fall back to the
      // shared scope walker to find the enclosing class_definition and
      // disambiguate by class scope.
      if (classScopedMethods && treeRoot) {
        const scoped = resolveSelfMethodWithScope({
          methodName: member,
          callerRange: {
            startLine: call.range.startLine,
            startCol: call.range.startCol,
          },
          treeRoot,
          classes: classScopedMethods.classes,
          methodsByClass: classScopedMethods.methodsByClass,
        });
        if (scoped) {
          return {
            symbolId: scoped,
            isResolved: true,
            confidence: confidenceFor("receiver-self"),
            resolution: "receiver-self-scope",
          };
        }
      }
    }

    const importedInstanceMethodCall = resolveImportedInstanceMethodCall({
      identifier,
      callRange: call.range,
      callerRange,
      content,
      importedNameToSymbolIds,
      methodsByImportedClassSymbolId,
    });
    if (importedInstanceMethodCall) {
      return importedInstanceMethodCall;
    }
  }

  return {
    symbolId: null,
    isResolved: false,
    confidence: confidenceFor("heuristic-only"),
    resolution: "unresolved",
    targetName: identifier,
    candidateCount: importedCandidates?.length ?? 0,
  };
}

async function resolvePythonCallEdgesPass2(params: {
  repoId: string;
  repoRoot: string;
  fileMeta: FileMetadata;
  createdCallEdges: Set<string>;
  telemetry?: Pass2ResolverContext["telemetry"];
  mode?: "full" | "incremental";
  submitEdgeWrite?: Pass2ResolverContext["submitEdgeWrite"];
  importCache?: Pass2ResolverContext["importCache"];
}): Promise<number> {
  const {
    repoId,
    repoRoot,
    fileMeta,
    createdCallEdges,
    telemetry,
    mode,
    submitEdgeWrite,
    importCache,
  } = params;

  const conn = await getLadybugConn();
  const filePath = join(repoRoot, fileMeta.path);
  let content: string;
  try {
    content = await readFileAsync(filePath, "utf-8");
  } catch (readError: unknown) {
    const code = (readError as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EPERM") {
      logger.warn(
        `File disappeared before Python pass2 resolution: ${fileMeta.path}`,
        { code },
      );
      return 0;
    }
    throw readError;
  }

  const adapter = getAdapterForExtension(".py");
  if (!adapter) {
    return 0;
  }

  const tree = adapter.parse(content, filePath);
  if (!tree) {
    return 0;
  }

  let extractedSymbols: ExtractedSymbol[];
  let calls: ExtractedCall[];
  let imports: ReturnType<typeof adapter.extractImports>;
  // Phase 2 Task 2.1.3: capture the tree root so the self.method() scope-walker
  // fallback can find the enclosing class_definition. The tree is kept alive
  // until the end of this function so node references remain valid.
  const treeRoot: ScopeNode = (tree as unknown as { rootNode: ScopeNode })
    .rootNode;
  try {
    extractedSymbols = adapter.extractSymbols(
      tree,
      content,
      filePath,
    ) as ExtractedSymbol[];
    calls = adapter.extractCalls(
      tree,
      content,
      filePath,
      extractedSymbols as never,
    ) as ExtractedCall[];
    imports = adapter.extractImports(tree, content, filePath);
  } catch (e) {
    (tree as unknown as { delete?: () => void }).delete?.();
    throw e;
  }

  const fileRecord = await ladybugDb.getFileByRepoPath(
    conn,
    repoId,
    fileMeta.path,
  );
  if (!fileRecord) {
    return 0;
  }

  const existingSymbols = await ladybugDb.getSymbolsByFile(
    conn,
    fileRecord.fileId,
  );
  if (existingSymbols.length === 0) {
    return 0;
  }

  const filteredSymbolDetails = mapExtractedSymbolsToExisting(
    fileMeta.path,
    extractedSymbols,
    existingSymbols,
    telemetry,
  );
  if (filteredSymbolDetails.length === 0) {
    return 0;
  }

  const symbolIdsToRefresh = filteredSymbolDetails.map(
    (detail) => detail.symbolId,
  );
  clearLocalCallDedupKeys(symbolIdsToRefresh, createdCallEdges);

  const nodeIdToSymbolId = createNodeIdToSymbolId(filteredSymbolDetails);
  const localClassMethodNameToSymbolIds = buildLocalClassMethodIndex(
    filteredSymbolDetails,
  );
  const importResolution = await resolveImportTargets(
    repoId,
    repoRoot,
    fileMeta.path,
    imports,
    [...adapter.fileExtensions],
    "python",
    content,
    importCache,
  );
  const pythonImportMaps = await resolvePythonImportMaps({
    conn,
    repoId,
    repoRoot,
    importerRelPath: fileMeta.path,
    imports,
    extensions: [...adapter.fileExtensions],
    importCache,
  });
  const importedNameToSymbolIds = mergeImportedNameMaps(
    importResolution.importedNameToSymbolIds,
    pythonImportMaps.importedNameToSymbolIds,
  );
  const namespaceImports = mergeNamespaceImports(
    importResolution.namespaceImports,
    pythonImportMaps.namespaceImports,
  );
  const now = new Date().toISOString();
  const edgesToInsert: ladybugDb.EdgeRow[] = [];
  let createdEdges = 0;

  const localFunctionNameIndex = buildLocalFunctionNameIndex(
    filteredSymbolDetails,
  );
  const classScopedMethods = buildClassScopedMethodIndex(filteredSymbolDetails);
  // Phase 2 Task 2.1.1: emit edges from decorated functions to their decorators.
  for (const detail of filteredSymbolDetails) {
    const decs = detail.extractedSymbol.decorators;
    if (!decs || decs.length === 0) continue;
    const decoratorTargets = resolveDecoratorTargets({
      decorators: decs,
      localFunctionNameIndex,
      importedNameToSymbolIds,
      onAmbiguous: telemetry
        ? () =>
            recordPass2ResolverUnresolved(
              telemetry,
              "pass2-python",
              "ambiguous",
            )
        : undefined,
    });
    for (const targetId of decoratorTargets) {
      const edgeKey = `${detail.symbolId}->${targetId}`;
      if (createdCallEdges.has(edgeKey)) continue;
      edgesToInsert.push({
        repoId,
        fromSymbolId: detail.symbolId,
        toSymbolId: targetId,
        edgeType: "call",
        weight: 1.0,
        confidence: confidenceFor("heuristic-only"),
        resolution: "decorator-chain",
        resolverId: "pass2-python",
        resolutionPhase: "pass2",
        provenance: `python-decorator:${detail.extractedSymbol.name}`,
        createdAt: now,
      });
      createdCallEdges.add(edgeKey);
      createdEdges++;
      if (telemetry)
        recordPass2ResolverEdge(telemetry, "pass2-python", "heuristic");
    }
  }

  for (const detail of filteredSymbolDetails) {
    for (const call of calls) {
      const callerNodeId =
        call.callerNodeId ??
        findEnclosingSymbolByRange(call.range, filteredSymbolDetails);
      if (callerNodeId !== detail.extractedSymbol.nodeId) {
        continue;
      }

      const resolved = resolvePythonPass2CallTarget({
        call,
        callerRange: detail.extractedSymbol.range,
        content,
        nodeIdToSymbolId,
        importedNameToSymbolIds,
        namespaceImports,
        localClassMethodNameToSymbolIds,
        methodsByImportedClassSymbolId:
          pythonImportMaps.methodsByImportedClassSymbolId,
        treeRoot,
        classScopedMethods,
      });
      if (!resolved) {
        continue;
      }

      if (resolved.isResolved && resolved.symbolId) {
        const edgeKey = `${detail.symbolId}->${resolved.symbolId}`;
        if (createdCallEdges.has(edgeKey)) {
          continue;
        }
        edgesToInsert.push({
          repoId,
          fromSymbolId: detail.symbolId,
          toSymbolId: resolved.symbolId,
          edgeType: "call",
          weight: 1.0,
          confidence: resolved.confidence,
          resolution: resolved.resolution,
          resolverId: "pass2-python",
          resolutionPhase: "pass2",
          provenance: `python-call:${call.calleeIdentifier}`,
          createdAt: now,
        });
        createdCallEdges.add(edgeKey);
        createdEdges++;
        if (telemetry) {
          recordPass2ResolverEdge(
            telemetry,
            "pass2-python",
            bucketForResolution(resolved.resolution),
          );
        }
      } else if (resolved.targetName) {
        const unresolvedTargetId = `unresolved:call:${resolved.targetName}`;
        const edgeKey = `${detail.symbolId}->${unresolvedTargetId}`;
        if (createdCallEdges.has(edgeKey)) {
          continue;
        }
        edgesToInsert.push({
          repoId,
          fromSymbolId: detail.symbolId,
          toSymbolId: unresolvedTargetId,
          edgeType: "call",
          weight: 0.5,
          confidence: resolved.confidence,
          resolution: "unresolved",
          resolverId: "pass2-python",
          resolutionPhase: "pass2",
          provenance: `unresolved-python-call:${call.calleeIdentifier}${resolved.candidateCount ? `:candidates=${resolved.candidateCount}` : ""}`,
          createdAt: now,
        });
        createdCallEdges.add(edgeKey);
        createdEdges++;
        if (telemetry) {
          recordPass2ResolverUnresolved(
            telemetry,
            "pass2-python",
            "unresolved",
          );
        }
      }
    }
  }

  if (submitEdgeWrite) {
    await submitEdgeWrite({
      symbolIdsToRefresh,
      edges: edgesToInsert,
    });
  } else {
    await withWriteConn(async (wConn) => {
      if (mode !== "full" && symbolIdsToRefresh.length > 0) {
        await ladybugDb.deleteOutgoingEdgesByTypeForSymbols(
          wConn,
          symbolIdsToRefresh,
          "call",
        );
      }
      await ladybugDb.insertEdges(wConn, edgesToInsert);
    });
  }
  (tree as unknown as { delete?: () => void }).delete?.();
  return createdEdges;
}

export class PythonPass2Resolver implements Pass2Resolver {
  readonly id = "pass2-python";

  supports(target: Pass2Target): boolean {
    return (
      target.language === "python" &&
      PYTHON_PASS2_EXTENSIONS.has(target.extension)
    );
  }

  async resolve(
    target: Pass2Target,
    context: Pass2ResolverContext,
  ): Promise<Pass2ResolverResult> {
    if (!target.repoId) {
      throw new Error("PythonPass2Resolver requires target.repoId");
    }

    try {
      const edgesCreated = await resolvePythonCallEdgesPass2({
        repoId: target.repoId,
        repoRoot: context.repoRoot,
        fileMeta: {
          path: target.filePath,
          size: 0,
          mtime: 0,
        },
        createdCallEdges: context.createdCallEdges,
        telemetry: context.telemetry,
        mode: context.mode,
        submitEdgeWrite: context.submitEdgeWrite,
        importCache: context.importCache,
      });
      return { edgesCreated };
    } catch (error) {
      logger.warn(
        `Python pass2 resolution failed for ${target.filePath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return { edgesCreated: 0 };
    }
  }
}
