import { extname } from "node:path";
import {
  ParserContractMismatchError,
  ParserEngineUnavailableError,
  ParserFileStateMissingError,
  ParserProvenanceIncompleteError,
  ParserSymbolRemapError,
} from "../domain/errors.js";
import type {
  EdgeRow,
  FileRow,
  SymbolReferenceRow,
  SymbolRow,
} from "../db/ladybug-queries.js";
import { getLadybugConn } from "../db/ladybug.js";
import { withReadOnlyTransaction } from "../db/ladybug-core.js";
import * as ladybugDb from "../db/ladybug-queries.js";
import {
  getFileParserState,
  getRepoParserState,
  type RepoParserStateRecord,
} from "../db/ladybug-parser-provenance.js";
import {
  getDerivedStateFromConnection,
  graphIntegrityIsVerifiedForVersion,
} from "../db/ladybug-derived-state.js";
import {
  type SymbolPlaceholderMeta,
  unresolvedCallDependencyTarget,
  unresolvedCallSymbolId,
} from "../db/symbol-placeholders.js";
import {
  getAdapterForExtension,
  getAdapterParserContract,
} from "../indexer/adapter/registry.js";
import { logger } from "../util/logger.js";
import { serializeTestCaseFacet } from "../util/test-case.js";
import {
  isBuiltinCall,
  resolveCallTarget,
  resolveImportTargets,
} from "../indexer/edge-builder.js";
import {
  generateAstFingerprint,
  generateSymbolId,
} from "../indexer/fingerprints.js";
import { resolveSymbolNodeForFingerprint } from "../indexer/parser/symbol-node-resolution.js";
import {
  buildSymbolReferences,
  isTestFile,
} from "../indexer/parser/helpers.js";
import { resolveSymbolEnrichment } from "../indexer/symbol-enrichment.js";
import {
  extractInvariants,
  extractSideEffects,
  generateSummary,
} from "../indexer/summaries.js";
import type { SymbolWithNodeId } from "../indexer/worker.js";
import { applyTestCaseCandidates } from "../indexer/test-case-normalizer.js";
import {
  NATIVE_PARSER_CONTRACT,
  selectParserContract,
  type ParserContract,
} from "../indexer/parser-provenance.js";
import {
  getNativeContentParserCapability,
  type RustExtractedSymbol,
} from "../indexer/rustIndexer.js";
import { hashContent } from "../util/hashing.js";
import { normalizePath } from "../util/paths.js";
import {
  parseDraftSource,
} from "./draft-source-parser.js";

export interface DraftParseInput {
  repoId: string;
  repoRoot: string;
  filePath: string;
  content: string;
  languages: string[];
  language?: string;
  version: number;
  ignorePatterns?: string[];
}

export interface DraftParseResult {
  version: number;
  graphVersionId: string;
  graphRevision: number;
  file: FileRow;
  symbols: SymbolRow[];
  edges: EdgeRow[];
  references: SymbolReferenceRow[];
  parserContract: ParserContract;
}

export interface DraftParserPreflight {
  repoId: string;
  relPath: string;
  durableFile: FileRow | null;
  durableSymbols: SymbolRow[];
  contract: ParserContract;
  graphVersionId: string;
  graphRevision: number;
  pruningSupported: boolean;
  repoParserState: RepoParserStateRecord;
}

function contractsMatch(
  recorded: ParserContract,
  available: ParserContract | undefined,
): boolean {
  return (
    available?.engine === recorded.engine &&
    available.engineContract === recorded.engineContract &&
    available.adapterKey === recorded.adapterKey &&
    available.language === recorded.language
  );
}

export function parserCoverageMatchesVerifiedGraph(
  derivedState: Awaited<ReturnType<typeof getDerivedStateFromConnection>>,
  versionId: string,
  repoParserState: RepoParserStateRecord | null,
): boolean {
  return Boolean(
    graphIntegrityIsVerifiedForVersion(derivedState, versionId) &&
    (repoParserState?.coverageState === "complete" ||
      repoParserState?.coverageState === "partial") &&
    repoParserState.graphVersionId === versionId &&
    repoParserState.graphRevision ===
      derivedState?.graphIntegrityVerifiedRevision,
  );
}

export function parserCoverageMatchesCurrentGraph(
  derivedState: Awaited<ReturnType<typeof getDerivedStateFromConnection>>,
  versionId: string,
  repoParserState: RepoParserStateRecord | null,
): boolean {
  const currentGraphIsMutable =
    graphIntegrityIsVerifiedForVersion(derivedState, versionId) ||
    (derivedState?.graphIntegrityState === "verifying" &&
      derivedState.graphIntegrityVersionId === versionId &&
      derivedState.graphIntegrityManifestEstablished === true &&
      typeof derivedState.graphIntegrityRevision === "number" &&
      typeof derivedState.graphIntegrityFilelessPruningSupported === "boolean");
  return Boolean(
    currentGraphIsMutable &&
    (repoParserState?.coverageState === "complete" ||
      repoParserState?.coverageState === "partial") &&
    repoParserState.graphVersionId === versionId &&
    repoParserState.graphRevision === derivedState?.graphIntegrityRevision,
  );
}

function assertRecordedContractAvailable(
  contract: ParserContract,
  relPath: string,
): void {
  if (contract.engine === "native") {
    if (!contractsMatch(contract, NATIVE_PARSER_CONTRACT)) {
      throw new ParserContractMismatchError(relPath, contract.engineContract);
    }
    const capability = getNativeContentParserCapability();
    if (!capability.available) {
      if (capability.reason === "contract-version-mismatch") {
        throw new ParserContractMismatchError(relPath, contract.engineContract);
      }
      throw new ParserEngineUnavailableError(relPath, contract.engineContract);
    }
    if (capability.contract !== contract.engineContract) {
      throw new ParserContractMismatchError(relPath, contract.engineContract);
    }
    return;
  }

  const extension = extname(relPath);
  if (!contractsMatch(contract, getAdapterParserContract(extension))) {
    throw new ParserContractMismatchError(relPath, contract.engineContract);
  }
}

export async function preflightDraftParser(
  input: {
    repoId: string;
    filePath: string;
  },
  options: { allowVerifyingGraph?: boolean } = {},
): Promise<DraftParserPreflight> {
  const relPath = normalizePath(input.filePath);
  const conn = await getLadybugConn();
  return withReadOnlyTransaction(conn, async () => {
    const latestVersion = await ladybugDb.getLatestVersion(conn, input.repoId);
    const derivedState = await getDerivedStateFromConnection(
      conn,
      input.repoId,
    );
    const repoParserState = await getRepoParserState(conn, input.repoId);
    const durableFile = await ladybugDb.getFileByRepoPath(
      conn,
      input.repoId,
      relPath,
    );

    const parserCoverageMatches = options.allowVerifyingGraph
      ? parserCoverageMatchesCurrentGraph
      : parserCoverageMatchesVerifiedGraph;
    if (
      !latestVersion ||
      !parserCoverageMatches(
        derivedState,
        latestVersion.versionId,
        repoParserState,
      )
    ) {
      throw new ParserProvenanceIncompleteError(
        relPath,
        "complete parser provenance",
      );
    }

    const durableFileId = durableFile?.fileId ?? input.repoId + ":" + relPath;
    const parserState = await getFileParserState(
      conn,
      input.repoId,
      durableFileId,
    );
    let contract: ParserContract;
    if (durableFile) {
      if (!parserState) {
        throw new ParserFileStateMissingError(
          relPath,
          "recorded parser contract",
        );
      }
      contract = {
        engine: parserState.engine,
        engineContract: parserState.engineContract,
        adapterKey: parserState.adapterKey,
        language: parserState.language,
      };
      assertRecordedContractAvailable(contract, relPath);
    } else {
      if (parserState) {
        throw new ParserProvenanceIncompleteError(
          relPath,
          "complete parser provenance",
        );
      }
      const extension = relPath.includes(".")
        ? relPath.slice(relPath.lastIndexOf("."))
        : "";
      const adapter = getAdapterForExtension(extension);
      contract = selectParserContract({
        repoRelativePath: relPath,
        language: adapter?.languageId ?? "",
        nativeCapability: getNativeContentParserCapability(),
        adapterContract: getAdapterParserContract(extension),
      });
    }

    return {
      repoId: input.repoId,
      relPath,
      durableFile,
      durableSymbols: durableFile
        ? await ladybugDb.getSymbolsByFile(conn, durableFile.fileId)
        : [],
      contract,
      graphVersionId: latestVersion.versionId,
      graphRevision: derivedState!.graphIntegrityRevision!,
      pruningSupported: derivedState!.graphIntegrityFilelessPruningSupported!,
      repoParserState: repoParserState!,
    };
  });
}

function computeDirectory(relPath: string): string {
  const normalized = normalizePath(relPath);
  const lastSlash = normalized.lastIndexOf("/");
  return lastSlash === -1 ? "" : normalized.slice(0, lastSlash);
}

type DurableSymbolMatchKey = `${string}:${string}:${number}:${number}`;

let durableSymbolFallbackObserver:
  | ((matchKey: DurableSymbolMatchKey) => void)
  | undefined;

/** Install deterministic test-only observability for durable-ID fallback use. */
export function _setDraftSymbolFallbackObserverForTests(
  observer?: (matchKey: DurableSymbolMatchKey) => void,
): void {
  durableSymbolFallbackObserver = observer;
}

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
  prepared?: DraftParserPreflight,
): Promise<DraftParseResult> {
  const preflight =
    prepared ??
    (await preflightDraftParser({
      repoId: input.repoId,
      filePath: input.filePath,
    }));
  const relPath = normalizePath(input.filePath);
  if (preflight.repoId !== input.repoId || preflight.relPath !== relPath) {
    throw new ParserContractMismatchError(
      relPath,
      preflight.contract.engineContract,
    );
  }
  const { contract, durableFile, durableSymbols } = preflight;
  const fileId = durableFile?.fileId ?? input.repoId + ":" + relPath;
  const extension = extname(relPath);
  const adapter = getAdapterForExtension(extension);
  if (!adapter) {
    throw new ParserContractMismatchError(relPath, contract.engineContract);
  }

  const timestamp = new Date().toISOString();
  const file: FileRow = {
    fileId,
    repoId: input.repoId,
    relPath,
    contentHash: hashContent(input.content),
    language: contract.language,
    byteSize: Buffer.byteLength(input.content, "utf8"),
    lastIndexedAt: null,
    directory: computeDirectory(relPath),
  };
  const extraction = await parseDraftSource({
    repoId: input.repoId,
    repoRelativePath: relPath,
    content: input.content,
    contract,
  });
  const tree = extraction.tree;

  try {
    const extractedSymbols = extraction.symbols;
    let symbolsWithNodeIds: SymbolWithNodeId[] = extractedSymbols.map(
      (symbol) => ({
        nodeId: symbol.nodeId,
        kind: symbol.kind,
        name: symbol.name,
        exported: symbol.exported,
        range: symbol.range,
        signature: symbol.signature,
        visibility: symbol.visibility,
        testCase: symbol.testCase,
        astFingerprint:
          contract.engine === "native"
            ? (symbol as RustExtractedSymbol).astFingerprint
            : "",
      }),
    );
    const imports = extraction.imports;
    let calls = extraction.calls;

    if (contract.engine === "typescript" && tree && adapter.detectTestCases) {
      try {
        const normalized = applyTestCaseCandidates({
          relPath,
          symbols: symbolsWithNodeIds,
          calls,
          candidates: adapter.detectTestCases({
            tree,
            content: input.content,
            filePath: relPath,
            symbols: symbolsWithNodeIds,
          }),
        });
        symbolsWithNodeIds = normalized.symbols;
        calls = normalized.calls;
        for (const diagnostic of normalized.diagnostics) {
          logger.warn(diagnostic);
        }
      } catch {
        logger.warn(`${relPath}: test-case detection failed`);
      }
    }

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
            undefined,
            input.ignorePatterns,
          )
        : {
            targets: [] as Array<{
              symbolId: string;
              provenance: string;
              targetMeta?: SymbolPlaceholderMeta;
            }>,
            importedNameToSymbolIds: new Map<string, string[]>(),
            namespaceImports: new Map<string, Map<string, string>>(),
          };

    const candidateDetails = symbolsWithNodeIds.map(
      (extractedSymbol, index) => {
        const sourceSymbol = extractedSymbols[index]!;
        let astFingerprint = extractedSymbol.astFingerprint ?? "";
        if (contract.engine === "typescript") {
          if (!tree) {
            throw new ParserEngineUnavailableError(
              relPath,
              contract.engineContract,
            );
          }
          const matchingNode = resolveSymbolNodeForFingerprint(tree, {
            kind: extractedSymbol.kind,
            name: extractedSymbol.name,
            startLine: extractedSymbol.range.startLine,
            startCol: extractedSymbol.range.startCol,
          });
          if (matchingNode) {
            astFingerprint = generateAstFingerprint(matchingNode);
          }
        }

        const candidateSymbolId =
          contract.engine === "native"
            ? (sourceSymbol as RustExtractedSymbol).symbolId
            : generateSymbolId(
                input.repoId,
                relPath,
                extractedSymbol.kind,
                extractedSymbol.name,
                astFingerprint,
              );
        return {
          extractedSymbol,
          sourceSymbol,
          candidateSymbolId,
          astFingerprint,
        };
      },
    );
    const remappedIds = resolveDraftSymbolRemap(
      durableSymbols,
      candidateDetails.map((detail) => ({
        symbolId: detail.candidateSymbolId,
        kind: detail.extractedSymbol.kind,
        name: detail.extractedSymbol.name,
        range: detail.extractedSymbol.range,
      })),
      relPath,
      contract.engineContract,
    );
    const symbolDetails = candidateDetails.map((detail) => {
      const remappedId = remappedIds.get(detail.candidateSymbolId);
      if (remappedId) {
        durableSymbolFallbackObserver?.(
          buildDurableSymbolMatchKey({
            kind: detail.extractedSymbol.kind,
            name: detail.extractedSymbol.name,
            startLine: detail.extractedSymbol.range.startLine,
            startCol: detail.extractedSymbol.range.startCol,
          }),
        );
      }
      return {
        ...detail,
        symbolId: remappedId ?? detail.candidateSymbolId,
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
      const nativeSymbol =
        contract.engine === "native"
          ? (detail.sourceSymbol as RustExtractedSymbol)
          : undefined;
      const summary =
        nativeSymbol?.summary ??
        generateSummary(extractedSymbol, input.content);
      const invariantsJson = nativeSymbol
        ? nativeSymbol.invariantsJson || null
        : (() => {
            const values = extractInvariants(extractedSymbol, input.content);
            return values.length > 0 ? JSON.stringify(values) : null;
          })();
      const sideEffectsJson = nativeSymbol
        ? nativeSymbol.sideEffectsJson || null
        : (() => {
            const values = extractSideEffects(extractedSymbol, input.content);
            return values.length > 0 ? JSON.stringify(values) : null;
          })();
      const enrichment = nativeSymbol
        ? {
            roleTagsJson: nativeSymbol.roleTagsJson || null,
            searchText: nativeSymbol.searchText,
          }
        : resolveSymbolEnrichment({
            kind: extractedSymbol.kind,
            name: extractedSymbol.name,
            relPath,
            summary,
            signature: extractedSymbol.signature,
            testCase: extractedSymbol.testCase,
          });

      return {
        symbolId: detail.symbolId,
        repoId: input.repoId,
        fileId,
        kind: extractedSymbol.kind,
        name: extractedSymbol.name,
        exported: extractedSymbol.exported,
        visibility: extractedSymbol.visibility || null,
        language: contract.language,
        rangeStartLine: extractedSymbol.range.startLine,
        rangeStartCol: extractedSymbol.range.startCol,
        rangeEndLine: extractedSymbol.range.endLine,
        rangeEndCol: extractedSymbol.range.endCol,
        astFingerprint: detail.astFingerprint,
        signatureJson: extractedSymbol.signature
          ? JSON.stringify(extractedSymbol.signature)
          : null,
        summary,
        invariantsJson,
        sideEffectsJson,
        roleTagsJson: enrichment.roleTagsJson,
        testCaseJson: extractedSymbol.testCase
          ? (serializeTestCaseFacet(extractedSymbol.testCase) ?? null)
          : null,
        searchText: enrichment.searchText,
        updatedAt: timestamp,
      };
    });

    const exportSymbols = symbolsWithNodeIds.filter(
      (symbol) => symbol.exported,
    );
    const edgeSourceSymbols =
      exportSymbols.length > 0 ? exportSymbols : symbolsWithNodeIds;

    const edges: EdgeRow[] = [];

    for (const detail of symbolDetails) {
      if (
        edgeSourceSymbols.some(
          (symbol) => symbol.nodeId === detail.extractedSymbol.nodeId,
        )
      ) {
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
            targetMeta: target.targetMeta,
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
          const unresolvedTargetId = unresolvedCallSymbolId(
            resolved.targetName,
          );
          edges.push({
            repoId: input.repoId,
            fromSymbolId: detail.symbolId,
            toSymbolId: unresolvedTargetId,
            edgeType: "call",
            weight: 0.5,
            confidence: resolved.confidence,
            resolution: "unresolved",
            resolverId: "pass1-generic",
            resolutionPhase: "pass1",
            provenance: `unresolved-call:${call.calleeIdentifier}`,
            createdAt: timestamp,
            targetMeta: unresolvedCallDependencyTarget(resolved.targetName),
          });
        }
      }
    }

    return {
      version: input.version,
      graphVersionId: preflight.graphVersionId,
      graphRevision: preflight.graphRevision,
      file,
      symbols,
      edges,
      references: isTestFile(relPath, input.languages)
        ? buildSymbolReferences(input.content, input.repoId, fileId)
        : [],
      parserContract: contract,
    };
  } finally {
    if (
      tree &&
      typeof (tree as unknown as { delete?: () => void }).delete === "function"
    ) {
      (tree as unknown as { delete: () => void }).delete();
    }
  }
}

export interface DurableDraftSymbolRemapInput {
  symbolId: string;
  kind: string;
  name: string;
  rangeStartLine: number;
  rangeStartCol: number;
}

export interface DraftSymbolRemapCandidate {
  symbolId: string;
  kind: string;
  name: string;
  range: { startLine: number; startCol: number };
}

export function resolveDraftSymbolRemap(
  durableSymbols: readonly DurableDraftSymbolRemapInput[],
  parsedSymbols: readonly DraftSymbolRemapCandidate[],
  repoRelativePath: string,
  requiredContract: string,
): Map<string, string> {
  const durableByKey = new Map<string, string>();
  for (const symbol of durableSymbols) {
    const key = buildDurableSymbolMatchKey({
      kind: symbol.kind,
      name: symbol.name,
      startLine: symbol.rangeStartLine,
      startCol: symbol.rangeStartCol,
    });
    if (durableByKey.has(key)) {
      throw new ParserSymbolRemapError(repoRelativePath, requiredContract);
    }
    durableByKey.set(key, symbol.symbolId);
  }

  const remapped = new Map<string, string>();
  const parsedKeys = new Set<string>();
  const parsedIds = new Set<string>();
  const usedDurableIds = new Set<string>();
  for (const symbol of parsedSymbols) {
    const key = buildDurableSymbolMatchKey({
      kind: symbol.kind,
      name: symbol.name,
      startLine: symbol.range.startLine,
      startCol: symbol.range.startCol,
    });
    if (parsedKeys.has(key) || parsedIds.has(symbol.symbolId)) {
      throw new ParserSymbolRemapError(repoRelativePath, requiredContract);
    }
    parsedKeys.add(key);
    parsedIds.add(symbol.symbolId);

    const durableId = durableByKey.get(key);
    if (durableId) {
      if (usedDurableIds.has(durableId)) {
        throw new ParserSymbolRemapError(repoRelativePath, requiredContract);
      }
      usedDurableIds.add(durableId);
      remapped.set(symbol.symbolId, durableId);
    }
  }

  const finalIds = new Set<string>();
  for (const symbol of parsedSymbols) {
    const finalId = remapped.get(symbol.symbolId) ?? symbol.symbolId;
    if (finalIds.has(finalId)) {
      throw new ParserSymbolRemapError(repoRelativePath, requiredContract);
    }
    finalIds.add(finalId);
  }
  return remapped;
}
