import { join } from "path";

import type { SyntaxNode, Tree } from "tree-sitter";

import { getLadybugConn } from "../../../db/ladybug.js";
import * as ladybugDb from "../../../db/ladybug-queries.js";
import type { SymbolRow } from "../../../db/ladybug-queries.js";
import type { SymbolKind } from "../../../db/schema.js";
import { readFileAsync } from "../../../util/asyncFs.js";
import { logger } from "../../../util/logger.js";
import { getAdapterForExtension } from "../../adapter/registry.js";
import type { FileMetadata } from "../../fileScanner.js";
import { findEnclosingSymbolByRange } from "../../edge-builder/pass2.js";
import { resolveImportTargets } from "../../edge-builder/import-resolution.js";

import type {
  Pass2Resolver,
  Pass2ResolverContext,
  Pass2ResolverResult,
  Pass2Target,
} from "../types.js";

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
  signature?: {
    params?: Array<{ name: string; type?: string }>;
    returns?: string;
  };
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

type GoResolvedCall = {
  symbolId: string | null;
  isResolved: boolean;
  confidence: number;
  resolution: string;
  targetName?: string;
  candidateCount?: number;
};

type GoPackageIndex = {
  packageByFilePath: Map<string, string>;
  symbolsByPackage: Map<string, Array<SymbolRow & { relPath: string }>>;
};

const GO_PASS2_EXTENSIONS = new Set([".go"]);

function normalizeReceiverType(receiverType: string | undefined): string {
  return (receiverType ?? "").replace(/^\*/, "").trim();
}

function parseSignatureParams(
  signatureJson: string | null,
): Array<{ name: string; type?: string }> {
  if (!signatureJson) {
    return [];
  }
  try {
    const parsed = JSON.parse(signatureJson) as {
      params?: Array<{ name: string; type?: string }>;
    };
    return Array.isArray(parsed.params) ? parsed.params : [];
  } catch {
    return [];
  }
}

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

async function clearOutgoingCallEdges(
  conn: import("kuzu").Connection,
  symbolIds: string[],
  createdCallEdges: Set<string>,
): Promise<void> {
  if (symbolIds.length === 0) {
    return;
  }

  await ladybugDb.deleteOutgoingEdgesByTypeForSymbols(conn, symbolIds, "call");
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

function createLocalNameIndex(
  filteredSymbolDetails: FilteredSymbolDetail[],
): Map<string, string[]> {
  const nameToSymbolIds = new Map<string, string[]>();
  for (const detail of filteredSymbolDetails) {
    const existing = nameToSymbolIds.get(detail.extractedSymbol.name) ?? [];
    existing.push(detail.symbolId);
    nameToSymbolIds.set(detail.extractedSymbol.name, existing);
  }
  return nameToSymbolIds;
}

async function buildGoPackageIndex(
  repoId: string,
  cache?: Map<string, unknown>,
): Promise<GoPackageIndex> {
  const cacheKey = `pass2-go:package-index:${repoId}`;
  const cached = cache?.get(cacheKey);
  if (cached) {
    return cached as GoPackageIndex;
  }

  const conn = await getLadybugConn();
  const repoFiles = await ladybugDb.getFilesByRepo(conn, repoId);
  const goFiles = repoFiles.filter((file) => file.language === "go");
  const goFileIds = new Set(goFiles.map((file) => file.fileId));
  const fileById = new Map(goFiles.map((file) => [file.fileId, file]));
  const packageByFilePath = new Map<string, string>();
  const symbolsByPackage = new Map<
    string,
    Array<SymbolRow & { relPath: string }>
  >();

  const repoSymbols = await ladybugDb.getSymbolsByRepo(conn, repoId);
  for (const symbol of repoSymbols) {
    if (!goFileIds.has(symbol.fileId)) {
      continue;
    }
    const file = fileById.get(symbol.fileId);
    if (!file) {
      continue;
    }
    if (symbol.kind === "module") {
      packageByFilePath.set(file.relPath, symbol.name);
    }
  }

  for (const symbol of repoSymbols) {
    if (!goFileIds.has(symbol.fileId)) {
      continue;
    }
    const file = fileById.get(symbol.fileId);
    if (!file) {
      continue;
    }
    const packageName = packageByFilePath.get(file.relPath);
    if (!packageName) {
      continue;
    }
    const bucket = symbolsByPackage.get(packageName) ?? [];
    bucket.push({
      ...symbol,
      relPath: file.relPath,
    });
    symbolsByPackage.set(packageName, bucket);
  }

  const packageIndex = { packageByFilePath, symbolsByPackage };
  cache?.set(cacheKey, packageIndex);
  return packageIndex;
}

function inferGoReceiverTypes(tree: Tree): Map<string, string> {
  const receiverTypes = new Map<string, string>();
  const visit = (node: SyntaxNode): void => {
    if (node.type === "short_var_declaration") {
      const expressionLists = node.children.filter(
        (child) => child.type === "expression_list",
      );
      const left = expressionLists[0];
      const right = expressionLists[1];
      const variableName = left?.children.find(
        (child) => child.type === "identifier",
      )?.text;
      const rightText = right?.text ?? "";
      const match =
        rightText.match(/^&?([A-Za-z_][A-Za-z0-9_]*)\s*\{/) ??
        rightText.match(/^new\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)/);
      if (variableName && match?.[1]) {
        receiverTypes.set(variableName, match[1]);
      }
    }

    if (node.type === "var_spec") {
      const identifierNode = node.children.find(
        (child) => child.type === "identifier",
      );
      const typeNode = node.children.find(
        (child) =>
          child.type === "type_identifier" || child.type === "pointer_type",
      );
      if (identifierNode && typeNode) {
        receiverTypes.set(
          identifierNode.text,
          typeNode.text.replace(/^\*/, ""),
        );
      }
    }

    for (const child of node.children) {
      visit(child);
    }
  };

  visit(tree.rootNode);
  return receiverTypes;
}

function buildReceiverMethodNamespaces(
  receiverTypes: Map<string, string>,
  samePackageSymbols: Array<SymbolRow & { relPath: string }>,
): Map<string, Map<string, string>> {
  const methodsByType = new Map<string, Map<string, string>>();
  for (const symbol of samePackageSymbols) {
    if (symbol.kind !== "method") {
      continue;
    }
    const signatureParams = parseSignatureParams(symbol.signatureJson);
    const receiverType = normalizeReceiverType(signatureParams[0]?.type);
    if (!receiverType) {
      continue;
    }
    const bucket = methodsByType.get(receiverType) ?? new Map<string, string>();
    bucket.set(symbol.name, symbol.symbolId);
    methodsByType.set(receiverType, bucket);
  }

  const receiverNamespaces = new Map<string, Map<string, string>>();
  for (const [variableName, receiverType] of receiverTypes) {
    const methods = methodsByType.get(normalizeReceiverType(receiverType));
    if (methods) {
      receiverNamespaces.set(variableName, methods);
    }
  }

  return receiverNamespaces;
}

function buildSamePackageFunctionIndex(
  samePackageSymbols: Array<SymbolRow & { relPath: string }>,
  currentFilePath: string,
): Map<string, string[]> {
  const samePackageNameToSymbolIds = new Map<string, string[]>();
  for (const symbol of samePackageSymbols) {
    if (symbol.relPath === currentFilePath) {
      continue;
    }
    if (symbol.kind !== "function") {
      continue;
    }
    const existing = samePackageNameToSymbolIds.get(symbol.name) ?? [];
    existing.push(symbol.symbolId);
    samePackageNameToSymbolIds.set(symbol.name, existing);
  }
  return samePackageNameToSymbolIds;
}

function resolveGoPass2CallTarget(params: {
  call: ExtractedCall;
  nodeIdToSymbolId: Map<string, string>;
  localNameToSymbolIds: Map<string, string[]>;
  samePackageNameToSymbolIds: Map<string, string[]>;
  importedNameToSymbolIds: Map<string, string[]>;
  namespaceImports: Map<string, Map<string, string>>;
  receiverNamespaces: Map<string, Map<string, string>>;
  globalNameToSymbolIds?: Map<string, string[]>;
}): GoResolvedCall | null {
  const {
    call,
    nodeIdToSymbolId,
    localNameToSymbolIds,
    samePackageNameToSymbolIds,
    importedNameToSymbolIds,
    namespaceImports,
    receiverNamespaces,
    globalNameToSymbolIds,
  } = params;

  if (call.calleeSymbolId && nodeIdToSymbolId.has(call.calleeSymbolId)) {
    return {
      symbolId: nodeIdToSymbolId.get(call.calleeSymbolId) ?? null,
      isResolved: true,
      confidence: 0.93,
      resolution: "same-file",
    };
  }

  const identifier = call.calleeIdentifier.replace(/^new\s+/, "").trim();
  if (!identifier) {
    return null;
  }

  if (identifier.includes(".")) {
    const parts = identifier.split(".");
    const prefix = parts[0];
    const member = parts[parts.length - 1];
    const receiverNamespace = receiverNamespaces.get(prefix);
    if (receiverNamespace?.has(member)) {
      return {
        symbolId: receiverNamespace.get(member) ?? null,
        isResolved: true,
        confidence: 0.85,
        resolution: "receiver-type",
      };
    }

    const namespace = namespaceImports.get(prefix);
    if (namespace?.has(member)) {
      return {
        symbolId: namespace.get(member) ?? null,
        isResolved: true,
        confidence: 0.9,
        resolution: "module-qualified",
      };
    }
  }

  const importedCandidates = importedNameToSymbolIds.get(identifier);
  if (importedCandidates && importedCandidates.length === 1) {
    return {
      symbolId: importedCandidates[0],
      isResolved: true,
      confidence: 0.82,
      resolution: "import-alias",
    };
  }

  const dotNamespace = namespaceImports.get(".");
  if (dotNamespace?.has(identifier)) {
    return {
      symbolId: dotNamespace.get(identifier) ?? null,
      isResolved: true,
      confidence: 0.82,
      resolution: "import-alias",
    };
  }

  const localCandidates = localNameToSymbolIds.get(identifier);
  if (localCandidates && localCandidates.length === 1) {
    return {
      symbolId: localCandidates[0],
      isResolved: true,
      confidence: 0.9,
      resolution: "same-file",
    };
  }

  const samePackageCandidates = samePackageNameToSymbolIds.get(identifier);
  if (samePackageCandidates && samePackageCandidates.length === 1) {
    return {
      symbolId: samePackageCandidates[0],
      isResolved: true,
      confidence: 0.92,
      resolution: "same-package",
    };
  }

  const globalCandidates = globalNameToSymbolIds?.get(identifier);
  if (globalCandidates && globalCandidates.length === 1) {
    return {
      symbolId: globalCandidates[0],
      isResolved: true,
      confidence: 0.45,
      resolution: "global-fallback",
    };
  }

  return {
    symbolId: null,
    isResolved: false,
    confidence: 0.35,
    resolution: "unresolved",
    targetName: identifier,
    candidateCount:
      (localCandidates?.length ?? 0) +
      (samePackageCandidates?.length ?? 0) +
      (importedCandidates?.length ?? 0),
  };
}

async function resolveGoCallEdgesPass2(params: {
  repoId: string;
  repoRoot: string;
  fileMeta: FileMetadata;
  languages: string[];
  createdCallEdges: Set<string>;
  globalNameToSymbolIds?: Map<string, string[]>;
  telemetry?: Pass2ResolverContext["telemetry"];
  cache?: Map<string, unknown>;
}): Promise<number> {
  const {
    repoId,
    repoRoot,
    fileMeta,
    languages,
    createdCallEdges,
    globalNameToSymbolIds,
    telemetry,
    cache,
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
        `File disappeared before Go pass2 resolution: ${fileMeta.path}`,
        { code },
      );
      return 0;
    }
    throw readError;
  }
  const adapter = getAdapterForExtension(".go");
  if (!adapter) {
    return 0;
  }

  const tree = adapter.parse(content, filePath);
  if (!tree) {
    return 0;
  }

  const extractedSymbols = adapter.extractSymbols(
    tree,
    content,
    filePath,
  ) as ExtractedSymbol[];
  const calls = adapter.extractCalls(
    tree,
    content,
    filePath,
    extractedSymbols as never,
  ) as ExtractedCall[];
  const imports = adapter.extractImports(tree, content, filePath);

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
  await clearOutgoingCallEdges(conn, symbolIdsToRefresh, createdCallEdges);

  const nodeIdToSymbolId = createNodeIdToSymbolId(filteredSymbolDetails);
  const localNameToSymbolIds = createLocalNameIndex(filteredSymbolDetails);
  const importResolution = await resolveImportTargets(
    repoId,
    repoRoot,
    fileMeta.path,
    imports,
    languages.map((language) => `.${language}`),
    "go",
    content,
  );

  const packageIndex = await buildGoPackageIndex(repoId, cache);
  const packageName =
    extractedSymbols.find((symbol) => symbol.kind === "module")?.name ??
    packageIndex.packageByFilePath.get(fileMeta.path);
  const samePackageSymbols = packageName
    ? (packageIndex.symbolsByPackage.get(packageName) ?? [])
    : [];
  const samePackageNameToSymbolIds = buildSamePackageFunctionIndex(
    samePackageSymbols,
    fileMeta.path,
  );
  const receiverTypes = inferGoReceiverTypes(tree);
  const receiverNamespaces = buildReceiverMethodNamespaces(
    receiverTypes,
    samePackageSymbols,
  );

  const now = new Date().toISOString();
  const edgesToInsert: ladybugDb.EdgeRow[] = [];
  let createdEdges = 0;

  for (const detail of filteredSymbolDetails) {
    for (const call of calls) {
      const callerNodeId =
        call.callerNodeId ??
        findEnclosingSymbolByRange(call.range, filteredSymbolDetails);
      if (callerNodeId !== detail.extractedSymbol.nodeId) {
        continue;
      }

      const resolved = resolveGoPass2CallTarget({
        call,
        nodeIdToSymbolId,
        localNameToSymbolIds,
        samePackageNameToSymbolIds,
        importedNameToSymbolIds: importResolution.importedNameToSymbolIds,
        namespaceImports: importResolution.namespaceImports,
        receiverNamespaces,
        globalNameToSymbolIds,
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
          resolverId: "pass2-go",
          resolutionPhase: "pass2",
          provenance: `go-call:${call.calleeIdentifier}`,
          createdAt: now,
        });
        createdCallEdges.add(edgeKey);
        createdEdges++;
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
          resolverId: "pass2-go",
          resolutionPhase: "pass2",
          provenance: `unresolved-go-call:${call.calleeIdentifier}${resolved.candidateCount ? `:candidates=${resolved.candidateCount}` : ""}`,
          createdAt: now,
        });
        createdCallEdges.add(edgeKey);
        createdEdges++;
      }
    }
  }

  await ladybugDb.insertEdges(conn, edgesToInsert);
  return createdEdges;
}

export class GoPass2Resolver implements Pass2Resolver {
  readonly id = "pass2-go";

  supports(target: Pass2Target): boolean {
    return (
      target.language === "go" && GO_PASS2_EXTENSIONS.has(target.extension)
    );
  }

  async resolve(
    target: Pass2Target,
    context: Pass2ResolverContext,
  ): Promise<Pass2ResolverResult> {
    if (!target.repoId) {
      throw new Error("GoPass2Resolver requires target.repoId");
    }

    try {
      const edgesCreated = await resolveGoCallEdgesPass2({
        repoId: target.repoId,
        repoRoot: context.repoRoot,
        fileMeta: {
          path: target.filePath,
          size: 0,
          mtime: 0,
        },
        languages: context.languages,
        createdCallEdges: context.createdCallEdges,
        globalNameToSymbolIds: context.globalNameToSymbolIds,
        telemetry: context.telemetry,
        cache: context.cache,
      });
      return { edgesCreated };
    } catch (error) {
      logger.warn(
        `Go pass2 resolution failed for ${target.filePath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return { edgesCreated: 0 };
    }
  }
}
