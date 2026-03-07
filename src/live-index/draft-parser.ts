import type {
  EdgeRow,
  FileRow,
  SymbolReferenceRow,
  SymbolRow,
} from "../db/kuzu-queries.js";
import { getKuzuConn } from "../db/kuzu.js";
import * as kuzuDb from "../db/kuzu-queries.js";
import { getAdapterForExtension } from "../indexer/adapter/registry.js";
import {
  isBuiltinCall,
  resolveCallTarget,
  resolveImportTargets,
} from "../indexer/edge-builder.js";
import { generateAstFingerprint, generateSymbolId } from "../indexer/fingerprints.js";
import { buildSymbolReferences, isTestFile } from "../indexer/parser/helpers.js";
import { resolveSymbolEnrichment } from "../indexer/symbol-enrichment.js";
import { extractInvariants, extractSideEffects, generateSummary } from "../indexer/summaries.js";
import type { SymbolWithNodeId } from "../indexer/worker.js";
import { hashContent } from "../util/hashing.js";
import { getAbsolutePathFromRepoRoot, normalizePath } from "../util/paths.js";

export interface DraftParseInput {
  repoId: string;
  repoRoot: string;
  filePath: string;
  content: string;
  languages: string[];
  language?: string;
  version: number;
}

export interface DraftParseResult {
  version: number;
  file: FileRow;
  symbols: SymbolRow[];
  edges: EdgeRow[];
  references: SymbolReferenceRow[];
}

function computeDirectory(relPath: string): string {
  const normalized = normalizePath(relPath);
  const lastSlash = normalized.lastIndexOf("/");
  return lastSlash === -1 ? "" : normalized.slice(0, lastSlash);
}

function getKindNodeTypes(kind: string): string[] {
  switch (kind) {
    case "function":
      return ["function_declaration", "function_definition"];
    case "class":
      return ["class_declaration", "class_definition"];
    case "interface":
      return ["interface_declaration"];
    case "type":
      return ["type_alias_declaration"];
    case "method":
      return ["method_definition"];
    case "variable":
      return ["variable_declaration"];
    default:
      return ["ambient_statement"];
  }
}

type DurableSymbolMatchKey = `${string}:${string}:${number}:${number}`;

function buildDurableSymbolMatchKey(params: {
  kind: string;
  name: string;
  startLine: number;
  startCol: number;
}): DurableSymbolMatchKey {
  return `${params.kind}:${params.name}:${params.startLine}:${params.startCol}`;
}

export async function parseDraftFile(
  input: DraftParseInput,
): Promise<DraftParseResult> {
  const relPath = normalizePath(input.filePath);
  const fileId = `${input.repoId}:${relPath}`;
  const ext = relPath.includes(".") ? relPath.slice(relPath.lastIndexOf(".") + 1) : "";
  const extWithDot = ext ? `.${ext}` : "";
  const adapter = getAdapterForExtension(extWithDot);
  const timestamp = new Date().toISOString();
  const file: FileRow = {
    fileId,
    repoId: input.repoId,
    relPath,
    contentHash: hashContent(input.content),
    language: ext || input.language || "unknown",
    byteSize: Buffer.byteLength(input.content, "utf8"),
    lastIndexedAt: null,
    directory: computeDirectory(relPath),
  };

  let durableSymbolsByMatchKey = new Map<DurableSymbolMatchKey, SymbolRow>();
  const conn = await getKuzuConn();
  const durableFile = await kuzuDb.getFileByRepoPath(conn, input.repoId, relPath);
  if (durableFile) {
    const durableSymbols = await kuzuDb.getSymbolsByFile(conn, durableFile.fileId);
    durableSymbolsByMatchKey = new Map(
      durableSymbols.map((symbol) => [
        buildDurableSymbolMatchKey({
          kind: symbol.kind,
          name: symbol.name,
          startLine: symbol.rangeStartLine,
          startCol: symbol.rangeStartCol,
        }),
        symbol,
      ]),
    );
  }

  if (!adapter) {
    return {
      version: input.version,
      file,
      symbols: [],
      edges: [],
      references: isTestFile(relPath, input.languages)
        ? buildSymbolReferences(input.content, input.repoId, fileId)
        : [],
    };
  }

  const absolutePath = getAbsolutePathFromRepoRoot(input.repoRoot, relPath);
  const tree = adapter.parse(input.content, absolutePath);
  if (!tree) {
    return {
      version: input.version,
      file,
      symbols: [],
      edges: [],
      references: [],
    };
  }

  try {
    let extractedSymbols: ReturnType<typeof adapter.extractSymbols> = [];
    try {
      extractedSymbols = adapter.extractSymbols(tree, input.content, absolutePath);
    } catch {
      extractedSymbols = [];
    }

    const symbolsWithNodeIds: SymbolWithNodeId[] = extractedSymbols.map((symbol) => ({
      nodeId: symbol.nodeId,
      kind: symbol.kind,
      name: symbol.name,
      exported: symbol.exported,
      range: symbol.range,
      signature: symbol.signature,
      visibility: symbol.visibility,
      astFingerprint: "",
    }));
    const imports = adapter.extractImports(tree, input.content, absolutePath);
    const calls = adapter.extractCalls(
      tree,
      input.content,
      absolutePath,
      symbolsWithNodeIds,
    );

    const importResolution =
      imports.length > 0
        ? await resolveImportTargets(
            input.repoId,
            input.repoRoot,
            relPath,
            imports,
            input.languages.map((language) => `.${language}`),
            adapter.languageId,
            input.content,
          )
        : {
            targets: [] as Array<{ symbolId: string; provenance: string }>,
            importedNameToSymbolIds: new Map<string, string[]>(),
            namespaceImports: new Map<string, Map<string, string>>(),
          };

    const symbolDetails = symbolsWithNodeIds.map((extractedSymbol) => {
      let astFingerprint = extractedSymbol.astFingerprint ?? "";
      const matchingNode = getKindNodeTypes(extractedSymbol.kind)
        .flatMap((kindNodeType) => tree.rootNode.descendantsOfType(kindNodeType))
        .find((node) => node.childForFieldName("name")?.text === extractedSymbol.name);
      if (matchingNode) {
        astFingerprint = generateAstFingerprint(matchingNode);
      }

      return {
        extractedSymbol,
        symbolId:
          durableSymbolsByMatchKey.get(
            buildDurableSymbolMatchKey({
              kind: extractedSymbol.kind,
              name: extractedSymbol.name,
              startLine: extractedSymbol.range.startLine,
              startCol: extractedSymbol.range.startCol,
            }),
          )?.symbolId ??
          generateSymbolId(
            input.repoId,
            relPath,
            extractedSymbol.kind,
            extractedSymbol.name,
            astFingerprint,
          ),
        astFingerprint,
      };
    });

    const nodeIdToSymbolId = new Map<string, string>();
    const nameToSymbolIds = new Map<string, string[]>();
    for (const detail of symbolDetails) {
      nodeIdToSymbolId.set(detail.extractedSymbol.nodeId, detail.symbolId);
      const existing = nameToSymbolIds.get(detail.extractedSymbol.name) ?? [];
      existing.push(detail.symbolId);
      nameToSymbolIds.set(detail.extractedSymbol.name, existing);
    }

    const symbols: SymbolRow[] = symbolDetails.map((detail) => {
      const extractedSymbol = detail.extractedSymbol;
      const summary = generateSummary(extractedSymbol, input.content);
      const invariants = extractInvariants(extractedSymbol, input.content);
      const sideEffects = extractSideEffects(extractedSymbol, input.content);
      const { roleTagsJson, searchText } = resolveSymbolEnrichment({
        kind: extractedSymbol.kind,
        name: extractedSymbol.name,
        relPath,
        summary,
        signature: extractedSymbol.signature,
      });

      return {
        symbolId: detail.symbolId,
        repoId: input.repoId,
        fileId,
        kind: extractedSymbol.kind,
        name: extractedSymbol.name,
        exported: extractedSymbol.exported,
        visibility: extractedSymbol.visibility || null,
        language: adapter.languageId,
        rangeStartLine: extractedSymbol.range.startLine,
        rangeStartCol: extractedSymbol.range.startCol,
        rangeEndLine: extractedSymbol.range.endLine,
        rangeEndCol: extractedSymbol.range.endCol,
        astFingerprint: detail.astFingerprint,
        signatureJson: extractedSymbol.signature
          ? JSON.stringify(extractedSymbol.signature)
          : null,
        summary,
        invariantsJson: invariants.length > 0 ? JSON.stringify(invariants) : null,
        sideEffectsJson: sideEffects.length > 0 ? JSON.stringify(sideEffects) : null,
        roleTagsJson,
        searchText,
        updatedAt: timestamp,
      };
    });

    const exportSymbols = symbolsWithNodeIds.filter((symbol) => symbol.exported);
    const edgeSourceSymbols =
      exportSymbols.length > 0 ? exportSymbols : symbolsWithNodeIds;

    const edges: EdgeRow[] = [];

    for (const detail of symbolDetails) {
      if (edgeSourceSymbols.some((symbol) => symbol.nodeId === detail.extractedSymbol.nodeId)) {
        for (const target of importResolution.targets) {
          edges.push({
            repoId: input.repoId,
            fromSymbolId: detail.symbolId,
            toSymbolId: target.symbolId,
            edgeType: "import",
            weight: 0.6,
            confidence: 1.0,
            resolution: "exact",
            provenance: `import:${target.provenance}`,
            createdAt: timestamp,
          });
        }
      }

      for (const call of calls) {
        if (call.callerNodeId !== detail.extractedSymbol.nodeId) {
          continue;
        }

        const resolved = resolveCallTarget(
          call,
          nodeIdToSymbolId,
          nameToSymbolIds,
          importResolution.importedNameToSymbolIds,
          importResolution.namespaceImports,
          adapter,
        );

        if (!resolved) {
          continue;
        }

        if (resolved.isResolved && resolved.symbolId) {
          edges.push({
            repoId: input.repoId,
            fromSymbolId: detail.symbolId,
            toSymbolId: resolved.symbolId,
            edgeType: "call",
            weight: 1.0,
            confidence: resolved.confidence,
            resolution: resolved.strategy,
            resolverId: "pass1-generic",
            resolutionPhase: "pass1",
            provenance: `call:${call.calleeIdentifier}`,
            createdAt: timestamp,
          });
        } else if (resolved.targetName && !isBuiltinCall(resolved.targetName)) {
          edges.push({
            repoId: input.repoId,
            fromSymbolId: detail.symbolId,
            toSymbolId: `unresolved:call:${resolved.targetName}`,
            edgeType: "call",
            weight: 0.5,
            confidence: resolved.confidence,
            resolution: "unresolved",
            resolverId: "pass1-generic",
            resolutionPhase: "pass1",
            provenance: `unresolved-call:${call.calleeIdentifier}`,
            createdAt: timestamp,
          });
        }
      }
    }

    return {
      version: input.version,
      file,
      symbols,
      edges,
      references: isTestFile(relPath, input.languages)
        ? buildSymbolReferences(input.content, input.repoId, fileId)
        : [],
    };
  } finally {
    // tree.delete() is not available in tree-sitter 0.21.x
  }
}
