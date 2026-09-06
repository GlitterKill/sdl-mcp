import type { RepoConfig } from "../config/types.js";
import { WATCHER_REINDEX_MAX_ATTEMPTS } from "../config/constants.js";
import {
  advanceGraphIntegrityRevisionInTransaction,
  getDerivedStateFromConnection,
  markCurrentGraphIntegrityRevisionFailed,
} from "../db/ladybug-derived-state.js";
import {
  getRepoParserState,
  upsertFileParserStatesInTransaction,
} from "../db/ladybug-parser-provenance.js";
import {
  applyGraphIntegrityFilePatchInTransaction,
  getGraphIntegrityFilelessStates,
  getGraphIntegrityFileState,
  GraphIntegrityManifestValidationError,
  type GraphIntegrityFileStateRecord,
  type GraphIntegrityFilelessStateRecord,
} from "../db/ladybug-graph-integrity.js";
import { deleteReconcileFileAuthoritiesInTransaction } from "../db/ladybug-semantic.js";
import { symbolCardCache } from "../graph/cache.js";
import {
  notifyGraphIntegrityVerifier,
  waitForGraphIntegrityVerifier,
} from "../indexer/provider-first/background-graph-integrity-verifier.js";
import {
  capturePersistedGraphIntegrity,
  createGraphIntegrityFileDigest,
  createGraphIntegrityFilelessDelta,
  createGraphIntegrityFilelessEdgeReferences,
  createGraphIntegrityFilelessReferenceTuples,
  createGraphIntegrityFilelessSymbols,
  createGraphIntegrityFileState,
  GRAPH_INTEGRITY_VERIFICATION_FAILURE,
  graphIntegrityFileStateMatchesDigest,
  GraphIntegrityVerificationError,
  parseGraphIntegrityFilelessReferences,
} from "../indexer/provider-first/persisted-graph-integrity.js";
import { withRepoWriteHeavyLock } from "../indexer/derived-refresh-queue.js";
import { getLadybugConn, withWriteConn } from "../db/ladybug.js";
import * as ladybugDb from "../db/ladybug-queries.js";
import { readFileAsync } from "../util/asyncFs.js";
import { hashContent } from "../util/hashing.js";
import { getAbsolutePathFromRepoRoot, normalizePath } from "../util/paths.js";
import {
  buildDependencyFrontier,
  type DependencyFrontier,
} from "./dependency-frontier.js";
import {
  parseDraftFile,
  parserCoverageMatchesCurrentGraph,
  preflightDraftParser,
  type DraftParseResult,
} from "./draft-parser.js";
import { IndexError } from "../domain/errors.js";
import { logger } from "../util/logger.js";
import { toExistingSymbol, toNewSymbol } from "./symbol-diff.js";

export interface SavedFilePatchRequest {
  repoId: string;
  filePath: string;
  content?: string;
  language?: string;
  version?: number;
  parseResult?: DraftParseResult | null;
}

export interface SavedFilePatchResult {
  repoId: string;
  filePath: string;
  fileId: string;
  symbolsUpserted: number;
  symbolsAdded: number;
  symbolsRemoved: number;
  symbolsPreserved: number;
  edgesUpserted: number;
  referencesUpserted: number;
  parseResult: DraftParseResult;
  frontier: DependencyFrontier;
}

/** @internal Saved-file commit timing and foreground-capture observability. */
export interface SavedFilePatchObserver {
  onCommitted(revision: number): void;
  onForegroundFullGraphCapture(): void;
}

class SavedFilePatchRetry extends Error {}

/** Preparation reports corruption without changing ownership or durable state. */
export class SavedFileBaselineError extends GraphIntegrityVerificationError {
  constructor(readonly baseline: { versionId: string; revision: number }) {
    super();
  }
}

export interface PreparedSavedFilePatch {
  repoId: string;
  filePath: string;
  content: string;
  contentHash: string;
  graphVersionId: string;
  graphRevision: number;
  parserContract: DraftParseResult["parserContract"];
  parseResult: DraftParseResult;
  frontier: DependencyFrontier;
  /** Exact resulting rows, including preserved provider facts, for atomic batch publication. */
  rows: {
    file: ladybugDb.FileRow;
    symbols: ladybugDb.SymbolRow[];
    edges: ladybugDb.EdgeRow[];
    references: ladybugDb.SymbolReferenceRow[];
    parserState: Parameters<
      typeof upsertFileParserStatesInTransaction
    >[1][number];
  };
  /** Caller owns the write-heavy lock and rechecks source/generation before commit.
   * Supplying an admitted writer also makes the caller responsible for publishing failures.
   */
  commit(writeConn?: Awaited<ReturnType<typeof getLadybugConn>>): Promise<SavedFilePatchResult | typeof RETRY_SAVED_FILE_PATCH>;
}

export const RETRY_SAVED_FILE_PATCH = Symbol("retry-saved-file-patch");

/** @internal Synchronous benchmark control; production saved edits never call it. */
export async function captureForegroundPersistedGraphIntegrity(
  observer: SavedFilePatchObserver | undefined,
  conn: Parameters<typeof capturePersistedGraphIntegrity>[0],
  repoId: string,
): ReturnType<typeof capturePersistedGraphIntegrity> {
  observer?.onForegroundFullGraphCapture();
  return capturePersistedGraphIntegrity(conn, repoId);
}

export async function patchSavedFile(
  request: SavedFilePatchRequest,
  observer?: SavedFilePatchObserver,
): Promise<SavedFilePatchResult> {
  for (let attempt = 0; attempt < WATCHER_REINDEX_MAX_ATTEMPTS; attempt += 1) {
    const result = await withRepoWriteHeavyLock(request.repoId, async () => {
      try {
        return await (await prepareSavedFilePatch(request, observer)).commit();
      } catch (error) {
        if (!(error instanceof SavedFileBaselineError)) throw error;
        return failOwnedSavedFileBaseline(request.repoId, error.baseline);
      }
    });
    if (result !== RETRY_SAVED_FILE_PATCH) return result;
    await waitForGraphIntegrityVerifier(request.repoId);
  }
  throw new IndexError(
    `Saved-file reconciliation lost graph integrity ownership for ${request.repoId}`,
  );
}

/** Read/parse/diff only. Publication stays deferred until commit is explicitly called. */
export async function prepareSavedFilePatch(
  request: SavedFilePatchRequest,
  observer?: SavedFilePatchObserver,
): Promise<PreparedSavedFilePatch> {
  request = { ...request };
  const conn = await getLadybugConn();
  const repo = await ladybugDb.getRepo(conn, request.repoId);
  if (!repo) {
    throw new IndexError(`Repository ${request.repoId} not found`);
  }

  let repoConfig: RepoConfig;
  try {
    repoConfig = JSON.parse(repo.configJson) as RepoConfig;
  } catch {
    logger.error("Corrupt configJson for repo", { repoId: request.repoId });
    throw new IndexError(`Corrupt configJson for repo ${request.repoId}`);
  }
  const relPath = normalizePath(request.filePath);
  const content =
    request.content ??
    (await readFileAsync(
      getAbsolutePathFromRepoRoot(repo.rootPath, relPath),
      "utf-8",
    ));
  const preflight = await preflightDraftParser(
    {
      repoId: request.repoId,
      filePath: relPath,
    },
    { allowVerifyingGraph: true },
  );
  const existingFile = preflight.durableFile;
  const existingSymbols = preflight.durableSymbols;
  const durableFileId = existingFile?.fileId ?? request.repoId + ":" + relPath;
  const integrityBaseline = {
    versionId: preflight.graphVersionId,
    revision: preflight.graphRevision,
    pruningSupported: preflight.pruningSupported,
    repoParserState: preflight.repoParserState,
  };

  let trustedFileState: GraphIntegrityFileStateRecord | null;
  try {
    trustedFileState = await getGraphIntegrityFileState(
      conn,
      request.repoId,
      durableFileId,
    );
  } catch (error) {
    if (!(error instanceof GraphIntegrityManifestValidationError)) throw error;
    throw new SavedFileBaselineError(integrityBaseline);
  }
  if (
    trustedFileState &&
    !graphIntegrityFileStateMatchesDigest(
      trustedFileState,
      createGraphIntegrityFileDigest({
        fileId: durableFileId,
        relPath,
        symbols: existingSymbols,
      }),
    )
  ) {
    throw new SavedFileBaselineError(integrityBaseline);
  }
  const hasTrustedFileBaseline =
    trustedFileState !== null || existingSymbols.length === 0;
  if (!hasTrustedFileBaseline) {
    throw new SavedFileBaselineError(integrityBaseline);
  }

  const cached = request.parseResult;
  const requiredContract = preflight.contract;
  const cachedContract = cached?.parserContract;
  const canReuseCached =
    cached !== null &&
    cached !== undefined &&
    cachedContract?.engine === requiredContract.engine &&
    cachedContract.engineContract === requiredContract.engineContract &&
    cachedContract.adapterKey === requiredContract.adapterKey &&
    cachedContract.language === requiredContract.language &&
    cached.version === (request.version ?? 0) &&
    cached.graphVersionId === preflight.graphVersionId &&
    cached.graphRevision === preflight.graphRevision &&
    cached.file.contentHash === hashContent(content) &&
    cached.file.repoId === request.repoId &&
    normalizePath(cached.file.relPath) === relPath;
  const parseResult = canReuseCached
    ? cached
    : await parseDraftFile(
        {
          repoId: request.repoId,
          repoRoot: repo.rootPath,
          filePath: relPath,
          content,
          languages: repoConfig.languages,
          language: request.language,
          version: request.version ?? 0,
        },
        preflight,
      );
  const frontier = await buildDependencyFrontier({
    conn, repoId: request.repoId,
    touchedSymbolIds: parseResult.symbols.map((symbol) => symbol.symbolId),
    outgoingEdges: parseResult.edges.map((edge) => ({
      toSymbolId: edge.toSymbolId,
      edgeType: edge.edgeType,
    })),
    currentFilePath: relPath,
  });

  const now = new Date().toISOString();
  const durableFile = {
    ...parseResult.file,
    fileId: durableFileId,
    repoId: request.repoId,
    relPath,
    lastIndexedAt: now,
  };
  const nextFileParserState = {
    stateId: JSON.stringify([request.repoId, durableFileId]),
    repoId: request.repoId,
    fileId: durableFileId,
    ...requiredContract,
  };
  const parsedSymbols = parseResult.symbols.map((symbol) => ({
    ...symbol,
    repoId: request.repoId,
    fileId: durableFileId,
  }));
  const parsedReferences = parseResult.references.map((reference) => ({
    ...reference,
    repoId: request.repoId,
    fileId: durableFileId,
  }));

  // Diff existing DB symbols against new tree-sitter-derived symbols
  const newSymbols = parsedSymbols.map(toNewSymbol);
  const existingMapped = existingSymbols.map((row) =>
    toExistingSymbol(row as Parameters<typeof toExistingSymbol>[0]),
  );
  const existingById = new Map(
    existingMapped.map((symbol) => [symbol.symbolId, symbol]),
  );
  const newIds = new Set(newSymbols.map((symbol) => symbol.symbolId));
  const diff = {
    matched: newSymbols.flatMap((symbol) => {
      const existing = existingById.get(symbol.symbolId);
      return existing ? [{ old: existing, new: symbol }] : [];
    }),
    added: newSymbols.filter((symbol) => !existingById.has(symbol.symbolId)),
    removed: existingMapped.filter(
      (symbol) => !newIds.has(symbol.symbolId) && symbol.source !== "scip",
    ),
    preserved: existingMapped.filter(
      (symbol) => !newIds.has(symbol.symbolId) && symbol.source === "scip",
    ),
  };
  const matchedNewToOldId = new Map(
    diff.matched.map((match) => [match.new.symbolId, match.old.symbolId]),
  );
  const addedIds = new Set(diff.added.map((symbol) => symbol.symbolId));
  const preservedIds = new Set(diff.preserved.map((symbol) => symbol.symbolId));
  const existingSymbolById = new Map(
    existingSymbols.map((symbol) => [symbol.symbolId, symbol]),
  );
  const symbolsToUpsert = parsedSymbols
    .filter(
      (symbol) =>
        matchedNewToOldId.has(symbol.symbolId) || addedIds.has(symbol.symbolId),
    )
    .map((symbol) => {
      const symbolId =
        matchedNewToOldId.get(symbol.symbolId) ?? symbol.symbolId;
      const existing = existingSymbolById.get(symbolId);
      return {
        ...symbol,
        symbolId,
        source: existing?.source ?? symbol.source,
        packageName: existing?.packageName ?? symbol.packageName,
        packageVersion: existing?.packageVersion ?? symbol.packageVersion,
        scipSymbol: existing?.scipSymbol ?? symbol.scipSymbol,
        updatedAt: now,
      };
    });
  const expectedSymbols = [
    ...symbolsToUpsert,
    ...existingSymbols.filter((symbol) => preservedIds.has(symbol.symbolId)),
  ];
  const expectedEdges = parseResult.edges.map((edge) => ({
    ...edge,
    fromSymbolId: matchedNewToOldId.get(edge.fromSymbolId) ?? edge.fromSymbolId,
  }));
  let nextFileState:
    | ReturnType<typeof createGraphIntegrityFileState>
    | undefined;
  let filelessDelta:
    | ReturnType<typeof createGraphIntegrityFilelessDelta>
    | undefined;
  let touchedFilelessSymbolIds = new Set<string>();
  let preparedEdges: ladybugDb.EdgeRow[] = [];
  if (integrityBaseline && hasTrustedFileBaseline) {
    let previousReferences: ReturnType<
      typeof parseGraphIntegrityFilelessReferences
    > = [];
    if (trustedFileState) {
      try {
        previousReferences = parseGraphIntegrityFilelessReferences(
          trustedFileState.filelessReferencesJson,
        );
      } catch {
        throw new SavedFileBaselineError(integrityBaseline);
      }
    }

    const existingEdges = await ladybugDb.getEdgesFromSymbols(
      conn,
      existingSymbols.map((symbol) => symbol.symbolId),
    );
    const matchedIds = new Set(diff.matched.map((match) => match.old.symbolId));
    const parserOwnedSourceIds = new Set([...matchedIds, ...addedIds]);
    const postWriteEdges = [
      ...expectedEdges.filter((edge) =>
        parserOwnedSourceIds.has(edge.fromSymbolId),
      ),
      ...diff.matched.flatMap((match) =>
        (existingEdges.get(match.old.symbolId) ?? []).filter(
          (edge) => edge.resolverId === "scip",
        ),
      ),
      ...diff.preserved.flatMap(
        (symbol) => existingEdges.get(symbol.symbolId) ?? [],
      ),
    ];
    preparedEdges = postWriteEdges;
    const nextFilelessSymbols = createGraphIntegrityFilelessSymbols({
      symbols: expectedSymbols,
      externalSymbols: [],
      edges: postWriteEdges,
    });
    touchedFilelessSymbolIds = new Set(
      nextFilelessSymbols
        .filter((symbol) => symbol.symbolId.startsWith("unresolved:"))
        .map((symbol) => symbol.symbolId),
    );
    const filelessSymbolIds = new Set([
      ...previousReferences.map((reference) => reference[0]),
      ...nextFilelessSymbols.map((symbol) => symbol.symbolId),
    ]);
    const nextEdgeReferences = createGraphIntegrityFilelessEdgeReferences(
      postWriteEdges,
      filelessSymbolIds,
      { trackSources: true },
    );
    const currentFileless = new Map<
      string,
      GraphIntegrityFilelessStateRecord
    >();
    try {
      for (const state of await getGraphIntegrityFilelessStates(
        conn,
        request.repoId,
        [...filelessSymbolIds],
      )) {
        currentFileless.set(state.symbolId, state);
      }
    } catch (error) {
      if (!(error instanceof GraphIntegrityManifestValidationError))
        throw error;
      throw new SavedFileBaselineError(integrityBaseline);
    }
    try {
      const nextReferences = createGraphIntegrityFilelessReferenceTuples(
        nextEdgeReferences,
        nextFilelessSymbols,
        currentFileless,
      );
      nextFileState = createGraphIntegrityFileState(
        request.repoId,
        durableFileId,
        relPath,
        expectedSymbols,
        nextReferences,
      );
      filelessDelta = createGraphIntegrityFilelessDelta(
        request.repoId,
        currentFileless,
        previousReferences,
        nextReferences,
        integrityBaseline.pruningSupported,
      );
    } catch {
      throw new SavedFileBaselineError(integrityBaseline);
    }
  }

  if (!nextFileState || !filelessDelta) {
    throw new SavedFileBaselineError(integrityBaseline);
  }

  const preparedFileState = nextFileState;
  const preparedFilelessDelta = filelessDelta;
  return {
    repoId: request.repoId,
    filePath: relPath,
    content,
    contentHash: hashContent(content),
    graphVersionId: integrityBaseline.versionId,
    graphRevision: integrityBaseline.revision,
    parserContract: requiredContract,
    parseResult,
    frontier,
    rows: {
      file: durableFile,
      symbols: expectedSymbols,
      edges: preparedEdges,
      references: parsedReferences,
      parserState: nextFileParserState,
    },
    commit,
  };

  // The existing transaction is reused by the legacy wrapper and future guarded
  // publisher. Its graph/parser CAS rejects preparation from an older baseline.
  async function commit(writeConn?: Awaited<ReturnType<typeof getLadybugConn>>): Promise<SavedFilePatchResult | typeof RETRY_SAVED_FILE_PATCH> {
    let committedRevision: number | undefined;
    let mutationStarted = false;
    try {
      const publish = async (wConn: Awaited<ReturnType<typeof getLadybugConn>>) => {
        await ladybugDb.withTransaction(wConn, async (txConn) => {
          const currentVersion = await ladybugDb.getLatestVersion(
            txConn,
            request.repoId,
          );
          const currentDerivedState = await getDerivedStateFromConnection(
            txConn,
            request.repoId,
          );
          const currentRepoParserState = await getRepoParserState(
            txConn,
            request.repoId,
          );
          if (
            currentVersion?.versionId !== integrityBaseline.versionId ||
            currentDerivedState?.graphIntegrityRevision !==
              integrityBaseline.revision ||
            !parserCoverageMatchesCurrentGraph(
              currentDerivedState,
              integrityBaseline.versionId,
              currentRepoParserState,
            ) ||
            currentRepoParserState?.coverageDigest !==
              integrityBaseline.repoParserState.coverageDigest
          ) {
            throw new SavedFilePatchRetry();
          }

          mutationStarted = true;
          await deleteReconcileFileAuthoritiesInTransaction(txConn, [
            durableFile.fileId,
          ]);
          await ladybugDb.upsertFile(txConn, durableFile);

          // Always refresh symbol references for this file
          await ladybugDb.deleteSymbolReferencesByFileId(
            txConn,
            durableFile.fileId,
          );
          await ladybugDb.insertSymbolReferences(txConn, parsedReferences);
          await ladybugDb.upsertSymbolBatch(txConn, symbolsToUpsert);

          // --- Matched symbols: update properties, refresh non-SCIP edges ---
          if (diff.matched.length > 0) {
            const matchedOldIds = diff.matched.map((m) => m.old.symbolId);

            // Delete only non-SCIP outgoing edges for matched symbols.
            // SCIP edges (resolverId === "scip") are preserved.
            await ladybugDb.deleteNonScipOutgoingEdges(txConn, matchedOldIds);

            // Insert fresh tree-sitter edges for matched symbols.
            // Filter to edges originating from matched old symbol IDs.
            const matchedEdges = parseResult.edges
              .filter((edge) => matchedNewToOldId.has(edge.fromSymbolId))
              .map((edge) => ({
                ...edge,
                // Remap fromSymbolId to the old (stable) symbol ID
                fromSymbolId:
                  matchedNewToOldId.get(edge.fromSymbolId) ?? edge.fromSymbolId,
                createdAt: now,
              }));
            if (matchedEdges.length > 0) {
              await ladybugDb.insertEdges(txConn, matchedEdges);
            }
          }

          // --- Added symbols: insert fresh ---
          if (diff.added.length > 0) {
            // Insert edges originating from added symbols
            const addedEdges = parseResult.edges
              .filter((edge) => addedIds.has(edge.fromSymbolId))
              .map((edge) => ({
                ...edge,
                createdAt: now,
              }));
            if (addedEdges.length > 0) {
              await ladybugDb.insertEdges(txConn, addedEdges);
            }
          }

          // --- Removed symbols: delete (source != "scip") ---
          if (diff.removed.length > 0) {
            const removedIds = diff.removed.map((s) => s.symbolId);
            await ladybugDb.deleteSymbolsByIds(txConn, removedIds);
          }

          // --- Preserved symbols: SCIP-only, leave untouched ---
          // (No action needed -- they survive reconciliation.)
          if (diff.preserved.length > 0) {
            logger.debug("SCIP-only symbols preserved during reconciliation", {
              repoId: request.repoId,
              filePath: relPath,
              preservedCount: diff.preserved.length,
              symbolIds: diff.preserved.map((s) => s.symbolId),
            });
          }

          await upsertFileParserStatesInTransaction(txConn, [
            nextFileParserState,
          ]);
          const nextCoverage = existingFile
            ? {
                coverageState: currentRepoParserState!.coverageState,
                coverageDigest: currentRepoParserState!.coverageDigest,
              }
            : await ladybugDb.summarizeParserCoverageInTransaction(
                txConn,
                request.repoId,
              );
          await ladybugDb.upsertRepoParserStateInTransaction(txConn, {
            ...currentRepoParserState!,
            ...nextCoverage,
            graphRevision: integrityBaseline.revision + 1,
          });

          // Keep physical placeholder rows and their manifest tuples in the same
          // transaction. ID scoping avoids a repo-wide placeholder scan on each
          // foreground save.
          await ladybugDb.normalizeDependencyPlaceholderSymbols(
            txConn,
            request.repoId,
            {
              fileIds: new Set([durableFile.fileId]),
              symbolIds: touchedFilelessSymbolIds,
            },
          );

          await applyGraphIntegrityFilePatchInTransaction(
            txConn,
            preparedFileState,
            preparedFilelessDelta,
          );
          committedRevision =
            (await advanceGraphIntegrityRevisionInTransaction(
              txConn,
              request.repoId,
              integrityBaseline.versionId,
              integrityBaseline.revision,
            )) ?? undefined;
          if (committedRevision === undefined) throw new SavedFilePatchRetry();
        });
      };
      // A guarded publisher can supply its already-admitted writer; the legacy
      // wrapper retains the original acquisition behavior.
      if (writeConn) await publish(writeConn);
      else await withWriteConn(publish);
    } catch (error) {
      if (error instanceof SavedFilePatchRetry) return RETRY_SAVED_FILE_PATCH;
      if (mutationStarted && !writeConn) {
        try {
          const failed = await markCurrentGraphIntegrityRevisionFailed(
            request.repoId,
            integrityBaseline.versionId,
            integrityBaseline.revision,
            GRAPH_INTEGRITY_VERIFICATION_FAILURE,
          );
          if (!failed) return RETRY_SAVED_FILE_PATCH;
        } catch (cleanupError) {
          logger.error("Failed to publish saved-file integrity failure", {
            repoId: request.repoId,
            cleanupError:
              cleanupError instanceof Error
                ? cleanupError.message
                : String(cleanupError),
          });
        }
      }
      throw error;
    }

    // Saved-file patches retain the ledger version used by the card cache key.
    symbolCardCache.invalidateRepo(request.repoId);

    if (committedRevision !== undefined) {
      try {
        observer?.onCommitted(committedRevision);
      } catch (error) {
        logger.debug("Saved-file patch observer failed", {
          repoId: request.repoId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      notifyGraphIntegrityVerifier(request.repoId);
    }

    return {
      repoId: request.repoId,
      filePath: relPath,
      fileId: durableFile.fileId,
      symbolsUpserted: diff.matched.length + diff.added.length,
      symbolsAdded: diff.added.length,
      symbolsRemoved: diff.removed.length,
      symbolsPreserved: diff.preserved.length,
      edgesUpserted: parseResult.edges.length,
      referencesUpserted: parsedReferences.length,
      parseResult: {
        ...parseResult,
        file: durableFile,
        symbols: parsedSymbols.map((symbol) => ({
          ...symbol,
          updatedAt: now,
        })),
        edges: parseResult.edges.map((edge) => ({
          ...edge,
          createdAt: now,
        })),
      },
      frontier,
    };
  }
}

async function failOwnedSavedFileBaseline(
  repoId: string,
  baseline: { versionId: string; revision: number },
): Promise<typeof RETRY_SAVED_FILE_PATCH> {
  const published = await markCurrentGraphIntegrityRevisionFailed(
    repoId,
    baseline.versionId,
    baseline.revision,
    GRAPH_INTEGRITY_VERIFICATION_FAILURE,
  );
  if (!published) return RETRY_SAVED_FILE_PATCH;
  throw new GraphIntegrityVerificationError();
}
