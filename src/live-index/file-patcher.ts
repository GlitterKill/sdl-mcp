import type { RepoConfig } from "../config/types.js";
import { WATCHER_REINDEX_MAX_ATTEMPTS } from "../config/constants.js";
import {
  advanceGraphIntegrityRevisionInTransaction,
  getDerivedState,
  graphIntegrityIsAvailableForVersion,
  invalidateGraphIntegrity,
  markCurrentGraphIntegrityRevisionFailed,
} from "../db/ladybug-derived-state.js";
import {
  applyGraphIntegrityFilePatchInTransaction,
  getGraphIntegrityFilelessStates,
  getGraphIntegrityFileState,
  GraphIntegrityManifestValidationError,
  ownsGraphIntegrityRevision,
  type GraphIntegrityFileStateRecord,
  type GraphIntegrityFilelessStateRecord,
} from "../db/ladybug-graph-integrity.js";
import { notifyGraphIntegrityVerifier } from "../indexer/provider-first/background-graph-integrity-verifier.js";
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
import { getAbsolutePathFromRepoRoot, normalizePath } from "../util/paths.js";
import {
  buildDependencyFrontier,
  type DependencyFrontier,
} from "./dependency-frontier.js";
import { parseDraftFile, type DraftParseResult } from "./draft-parser.js";
import { IndexError } from "../domain/errors.js";
import { logger } from "../util/logger.js";
import {
  diffSymbols,
  toExistingSymbol,
  toNewSymbol,
} from "./symbol-diff.js";

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

const RETRY_SAVED_FILE_PATCH = Symbol("retry-saved-file-patch");

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
    const result = await withRepoWriteHeavyLock(request.repoId, () =>
      patchSavedFileUnlocked(request, observer),
    );
    if (result !== RETRY_SAVED_FILE_PATCH) return result;
  }
  throw new IndexError(
    `Saved-file reconciliation lost graph integrity ownership for ${request.repoId}`,
  );
}

async function patchSavedFileUnlocked(
  request: SavedFilePatchRequest,
  observer?: SavedFilePatchObserver,
): Promise<SavedFilePatchResult | typeof RETRY_SAVED_FILE_PATCH> {
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
  const existingFile = await ladybugDb.getFileByRepoPath(
    conn,
    request.repoId,
    relPath,
  );
  const durableFileId = existingFile?.fileId ?? `${request.repoId}:${relPath}`;
  const existingSymbols = existingFile
    ? await ladybugDb.getSymbolsByFile(conn, existingFile.fileId)
    : [];
  const [latestVersion, derivedState] = await Promise.all([
    ladybugDb.getLatestVersion(conn, request.repoId),
    getDerivedState(request.repoId),
  ]);
  const integrityBaseline =
    latestVersion &&
    graphIntegrityIsAvailableForVersion(derivedState, latestVersion.versionId)
      ? {
          versionId: latestVersion.versionId,
          revision: derivedState!.graphIntegrityRevision!,
          pruningSupported:
            derivedState!.graphIntegrityFilelessPruningSupported!,
        }
      : undefined;
  let trustedFileState: GraphIntegrityFileStateRecord | null = null;
  if (integrityBaseline) {
    try {
      trustedFileState = await getGraphIntegrityFileState(
        conn,
        request.repoId,
        durableFileId,
      );
    } catch (error) {
      if (!(error instanceof GraphIntegrityManifestValidationError)) throw error;
      return failOwnedSavedFileBaseline(request.repoId, integrityBaseline);
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
      return failOwnedSavedFileBaseline(request.repoId, integrityBaseline);
    }
  }
  // Full indexing intentionally omits symbol-free files from the manifest.
  // The durable marker distinguishes a valid empty manifest from legacy state
  // that was marked verified without ever persisting manifest ownership.
  const hasTrustedFileBaseline =
    trustedFileState !== null ||
    (integrityBaseline !== undefined &&
      existingSymbols.length === 0 &&
      derivedState?.graphIntegrityManifestEstablished === true);

  const parseResult =
    request.parseResult ??
    (await parseDraftFile({
      repoId: request.repoId,
      repoRoot: repo.rootPath,
      filePath: relPath,
      content:
        request.content ??
        (await readFileAsync(
          getAbsolutePathFromRepoRoot(repo.rootPath, relPath),
          "utf-8",
        )),
      languages: repoConfig.languages,
      language: request.language,
      version: request.version ?? 0,
    }));

  const frontier = await buildDependencyFrontier({
    conn,
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
  const diff = diffSymbols(existingMapped, newSymbols);
  const matchedNewToOldId = new Map(
    diff.matched.map((match) => [match.new.symbolId, match.old.symbolId]),
  );
  const addedIds = new Set(diff.added.map((symbol) => symbol.symbolId));
  const preservedIds = new Set(
    diff.preserved.map((symbol) => symbol.symbolId),
  );
  const existingSymbolById = new Map(
    existingSymbols.map((symbol) => [symbol.symbolId, symbol]),
  );
  const expectedSymbols = [
    ...parsedSymbols
      .filter(
        (symbol) =>
          matchedNewToOldId.has(symbol.symbolId) ||
          addedIds.has(symbol.symbolId),
      )
      .map((symbol) => {
        const symbolId =
          matchedNewToOldId.get(symbol.symbolId) ?? symbol.symbolId;
        const existing = existingSymbolById.get(symbolId);
        return {
          ...symbol,
          symbolId,
          source: existing ? existing.source : symbol.source,
          scipSymbol: existing ? existing.scipSymbol : symbol.scipSymbol,
          updatedAt: now,
        };
      }),
    ...existingSymbols.filter((symbol) => preservedIds.has(symbol.symbolId)),
  ];
  const expectedEdges = parseResult.edges.map((edge) => ({
    ...edge,
    fromSymbolId:
      matchedNewToOldId.get(edge.fromSymbolId) ?? edge.fromSymbolId,
  }));
  let nextFileState: ReturnType<typeof createGraphIntegrityFileState> | undefined;
  let filelessDelta: ReturnType<typeof createGraphIntegrityFilelessDelta> | undefined;
  let touchedFilelessSymbolIds = new Set<string>();
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
        return failOwnedSavedFileBaseline(request.repoId, integrityBaseline);
      }
    }

    const existingEdges = await ladybugDb.getEdgesFromSymbols(
      conn,
      existingSymbols.map((symbol) => symbol.symbolId),
    );
    const matchedIds = new Set(diff.matched.map((match) => match.old.symbolId));
    const parserOwnedSourceIds = new Set([...matchedIds, ...addedIds]);
    const postWriteEdges = [
      ...expectedEdges.filter((edge) => parserOwnedSourceIds.has(edge.fromSymbolId)),
      ...diff.matched.flatMap((match) =>
        (existingEdges.get(match.old.symbolId) ?? []).filter(
          (edge) => edge.resolverId === "scip",
        ),
      ),
      ...diff.preserved.flatMap(
        (symbol) => existingEdges.get(symbol.symbolId) ?? [],
      ),
    ];
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
    const currentFileless = new Map<string, GraphIntegrityFilelessStateRecord>();
    try {
      for (const state of await getGraphIntegrityFilelessStates(
        conn,
        request.repoId,
        [...filelessSymbolIds],
      )) {
        currentFileless.set(state.symbolId, state);
      }
    } catch (error) {
      if (!(error instanceof GraphIntegrityManifestValidationError)) throw error;
      return failOwnedSavedFileBaseline(request.repoId, integrityBaseline);
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
      return failOwnedSavedFileBaseline(request.repoId, integrityBaseline);
    }
  }

  let committedRevision: number | undefined;
  try {
    await withWriteConn(async (wConn) => {
      await ladybugDb.withTransaction(wConn, async (txConn) => {
        if (integrityBaseline) {
          const currentVersion = await ladybugDb.getLatestVersion(
            txConn,
            request.repoId,
          );
          if (
            currentVersion?.versionId !== integrityBaseline.versionId ||
            !(await ownsGraphIntegrityRevision(
              txConn,
              request.repoId,
              integrityBaseline.versionId,
              integrityBaseline.revision,
            ))
          ) {
            throw new SavedFilePatchRetry();
          }
        }
        await ladybugDb.upsertFile(txConn, durableFile);

        // Always refresh symbol references for this file
        await ladybugDb.deleteSymbolReferencesByFileId(
          txConn,
          durableFile.fileId,
        );
        await ladybugDb.insertSymbolReferences(txConn, parsedReferences);

        // --- Matched symbols: update properties, refresh non-SCIP edges ---
        if (diff.matched.length > 0) {
          const matchedOldIds = diff.matched.map((m) => m.old.symbolId);

          // Delete only non-SCIP outgoing edges for matched symbols.
          // SCIP edges (resolverId === "scip") are preserved.
          await ladybugDb.deleteNonScipOutgoingEdges(txConn, matchedOldIds);

          // Batch matched symbols so a saved-file edit does not pay one native
          // LadybugDB round trip per symbol. Null provider fields tell the batch
          // upsert to preserve the existing SCIP identity on stable symbol IDs.
          const newSymbolLookup = new Map(
            parsedSymbols.map((s) => [s.symbolId, s]),
          );
          const matchedSymbols = diff.matched.flatMap(
            ({ old: oldSym, new: newSym }) => {
              const freshSymbol = newSymbolLookup.get(newSym.symbolId);
              return freshSymbol
                ? [
                    {
                      ...freshSymbol,
                      symbolId: oldSym.symbolId,
                      source: null,
                      packageName: null,
                      packageVersion: null,
                      scipSymbol: null,
                      updatedAt: now,
                    },
                  ]
                : [];
            },
          );
          await ladybugDb.upsertSymbolBatch(txConn, matchedSymbols);

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
          for (const symbol of parsedSymbols) {
            if (addedIds.has(symbol.symbolId)) {
              await ladybugDb.upsertSymbol(txConn, {
                ...symbol,
                updatedAt: now,
              });
            }
          }

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

        if (
          integrityBaseline &&
          hasTrustedFileBaseline &&
          nextFileState &&
          filelessDelta
        ) {
          await applyGraphIntegrityFilePatchInTransaction(
            txConn,
            nextFileState,
            filelessDelta,
          );
          committedRevision =
            (await advanceGraphIntegrityRevisionInTransaction(
              txConn,
              request.repoId,
              integrityBaseline.versionId,
              integrityBaseline.revision,
            )) ?? undefined;
          if (committedRevision === undefined) throw new SavedFilePatchRetry();
        } else {
          await invalidateGraphIntegrity(txConn, request.repoId);
        }
      });
    });
  } catch (error) {
    if (error instanceof SavedFilePatchRetry) return RETRY_SAVED_FILE_PATCH;
    throw error;
  }

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
