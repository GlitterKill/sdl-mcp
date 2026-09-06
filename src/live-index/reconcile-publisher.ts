import { hash } from "node:crypto";
import { lstat } from "node:fs/promises";
import type { Connection } from "kuzu";

import * as db from "../db/ladybug-queries.js";
import { forceDoubleEncoding } from "../db/ladybug-edges.js";
import { withExclusiveReadConnection, withWriteConn } from "../db/ladybug.js";
import {
  withReadOnlyTransaction,
  withTransaction,
} from "../db/ladybug-core.js";
import {
  advanceGraphIntegrityRevisionInTransaction,
  markDerivedStateDirtyInTransaction,
  getDerivedStateFromConnection,
} from "../db/ladybug-derived-state.js";
import {
  applyGraphIntegrityFilelessDeltaInTransaction,
  getGraphIntegrityFilelessStates,
} from "../db/ladybug-graph-integrity.js";
import { symbolCardCache } from "../graph/cache.js";
import { withRepoWriteHeavyLock } from "../indexer/derived-refresh-queue.js";
import { buildSymbolReferences } from "../indexer/parser/helpers.js";
import { notifyGraphIntegrityVerifier } from "../indexer/provider-first/background-graph-integrity-verifier.js";
import { readRepositoryFileBounded } from "../indexer/provider-first/executor.js";
import {
  materializeProviderRowsInTransaction,
  type ProviderFirstGraphRows,
} from "../indexer/provider-first/materializer.js";
import type { prepareReconcileFiles } from "../indexer/provider-first/reconcile-preparation.js";
import { providerFactsToSemanticProvenanceRecords } from "../indexer/provider-first/provenance.js";
import {
  mergeSemanticDiagnostics,
  mergeSemanticProviderRun,
  readReconcileFileAuthorities,
  writeReconcileFileAuthoritiesInTransaction,
  deleteReconcileFileAuthoritiesInTransaction,
  type ReconcileFileAuthority,
} from "../db/ladybug-semantic.js";
import {
  canonicalizePersistedGraphIntegritySymbol,
  createGraphIntegrityFileDigest,
  createGraphIntegrityFileState,
  createGraphIntegrityFilelessDelta,
  createGraphIntegrityFilelessEdgeReferences,
  createGraphIntegrityFilelessReferenceTuples,
  createGraphIntegrityFilelessSymbols,
  graphIntegrityFileStateMatchesDigest,
  parseGraphIntegrityFilelessReferences,
} from "../indexer/provider-first/persisted-graph-integrity.js";
import {
  isRepoEpochCurrent,
  withRepoMutation,
} from "../services/repo-lifecycle.js";
import { hashValue, normalizeValue } from "../util/hashing.js";
import { logger } from "../util/logger.js";
import { normalizePath, getAbsolutePathFromRepoRoot } from "../util/paths.js";
import { parserCoverageMatchesCurrentGraph } from "./draft-parser.js";
import { buildDependencyFrontier } from "./dependency-frontier.js";
import type { ReconcileClaim, ReconcileQueue } from "./reconcile-queue.js";

type Preparation = Awaited<ReturnType<typeof prepareReconcileFiles>>;
export interface ReconcilePublicationEvent {
  repoId: string;
  epoch: number;
  phase: "started" | "completed" | "failed";
}
const publicationListeners = new Set<
  (event: Readonly<ReconcilePublicationEvent>) => void | Promise<void>
>();
const publishingRepos = new Set<string>();

export function isReconcilePublishing(repoId: string): boolean {
  return publishingRepos.has(repoId);
}

/** Each connected MCP server owns its subscription and removes it on disconnect. */
export function subscribeReconcilePublication(
  listener: (
    event: Readonly<ReconcilePublicationEvent>,
  ) => void | Promise<void>,
): () => void {
  publicationListeners.add(listener);
  return () => {
    publicationListeners.delete(listener);
  };
}

function notifyPublication(event: ReconcilePublicationEvent): void {
  // Delivery must never extend writer ownership or make a committed graph fail.
  const failed = (error: unknown) =>
    logger.debug("Reconciliation notification delivery failed", { error });
  for (const listener of publicationListeners) {
    try {
      void Promise.resolve(listener(Object.freeze(event))).catch(failed);
    } catch (error) {
      failed(error);
    }
  }
}
export interface ReconcileGraphBaseline {
  versionId: string;
  revision: number;
  coverageDigest: string;
}
export class ReconcilePublicationStaleError extends Error {}

async function readBaseline(conn: Connection, repoId: string) {
  const version = await db.getLatestVersion(conn, repoId);
  const derived = await getDerivedStateFromConnection(conn, repoId);
  const parser = await db.getRepoParserState(conn, repoId);
  if (
    !version ||
    !parser ||
    !parserCoverageMatchesCurrentGraph(derived, version.versionId, parser)
  )
    throw new Error("Reconciliation requires a mutable owned graph baseline");
  return { version, derived: derived!, parser };
}

/** Capture before SCIP/LSP/parser execution; later graph changes require new preparation. */
export function captureReconcileGraphBaseline(
  repoId: string,
): Promise<ReconcileGraphBaseline> {
  return withExclusiveReadConnection((conn) =>
    withReadOnlyTransaction(conn, async () => {
      const { version, derived, parser } = await readBaseline(conn, repoId);
      return {
        versionId: version.versionId,
        revision: derived.graphIntegrityRevision!,
        coverageDigest: parser.coverageDigest,
      };
    }),
  );
}
export interface ReconcilePublicationRequest {
  repoId: string;
  repoRoot: string;
  epoch: number;
  baseline: ReconcileGraphBaseline;
  queue: ReconcileQueue;
  claim: ReconcileClaim;
  preparation?: Preparation;
  removedPaths?: readonly string[];
  /** Captured configuration and opaque provider dependency/inventory ownership. */
  assertCurrent(): boolean | Promise<boolean>;
}
export type ReconcilePublicationOutcome =
  | { kind: "stale" }
  | { kind: "noop" }
  | {
      kind: "published";
      revision: number;
      frontier: ReconcileClaim["frontier"];
    };

function sorted(rows: readonly unknown[]): string[] {
  return rows.map((row) => JSON.stringify(normalizeValue(row))).sort();
}
function symbolTuple(s: db.SymbolRow) {
  return [
    s.symbolId,
    s.repoId,
    s.fileId,
    s.kind,
    s.name,
    s.exported,
    s.visibility ?? "",
    s.language,
    s.rangeStartLine,
    s.rangeStartCol,
    s.rangeEndLine,
    s.rangeEndCol,
    s.astFingerprint,
    s.signatureJson ?? "",
    s.summary ?? "",
    s.invariantsJson ?? "",
    s.sideEffectsJson ?? "",
    s.summaryQuality ?? 0,
    s.summarySource ?? "unknown",
    s.roleTagsJson ?? "",
    s.testCaseJson ?? null,
    s.searchText ?? "",
    s.external ?? false,
    s.source ?? "",
    s.packageName ?? "",
    s.packageVersion ?? "",
    s.scipSymbol ?? "",
    s.symbolStatus ?? "real",
    s.placeholderKind ?? "",
    s.placeholderTarget ?? "",
  ];
}
function fileTuple(f: Omit<db.FileRow, "directory">) {
  return [
    f.fileId,
    f.repoId,
    normalizePath(f.relPath),
    f.contentHash,
    f.language,
    f.byteSize,
  ];
}
function referenceTuple(r: db.SymbolReferenceRow) {
  return [r.refId, r.repoId, r.fileId, r.symbolName, r.lineNumber];
}
function externalTuple(s: Partial<db.SymbolRow> & { symbolId: string }) {
  return [
    s.symbolId,
    s.repoId,
    s.kind,
    s.name,
    s.exported ?? true,
    s.language ?? "external",
    s.rangeStartLine ?? 0,
    s.rangeStartCol ?? 0,
    s.rangeEndLine ?? 0,
    s.rangeEndCol ?? 0,
    s.external ?? false,
    s.scipSymbol ?? "",
    s.source ?? "",
    s.packageName ?? "",
    s.packageVersion ?? "",
  ];
}
function edgeTuple(e: db.EdgeRow) {
  let provenance: unknown = e.provenance ?? "";
  if (e.provenance) {
    try {
      const parsed = JSON.parse(e.provenance) as Record<string, unknown>;
      // Only our run-owned temporary SCIP output path is operational metadata.
      if (
        typeof parsed.sourceIndexPath === "string" &&
        normalizePath(parsed.sourceIndexPath).includes(
          "/.sdl-mcp/provider-first-incremental/",
        )
      )
        delete parsed.sourceIndexPath;
      provenance = Object.keys(parsed)
        .sort()
        .map((key) => [key, parsed[key]]);
    } catch {
      /* Non-JSON provenance is still meaningful verbatim. */
    }
  }
  return [
    e.repoId,
    e.fromSymbolId,
    e.toSymbolId,
    e.edgeType,
    forceDoubleEncoding(e.weight),
    forceDoubleEncoding(e.confidence),
    e.resolution,
    e.resolverId ?? "pass1-generic",
    e.resolutionPhase ?? "pass1",
    provenance,
  ];
}
function uniqueEdges(edges: readonly db.EdgeRow[]) {
  return [
    ...new Map(
      edges.map((edge) => [
        JSON.stringify([
          edge.repoId,
          edge.fromSymbolId,
          edge.toSymbolId,
          edge.edgeType,
        ]),
        edge,
      ]),
    ).values(),
  ];
}

/** Snapshot all scoped DB ownership before waiting for publication admission. */
export async function prepareReconcilePublication(
  request: ReconcilePublicationRequest,
) {
  const preparation = request.preparation;
  if (preparation?.kind === "provider" && preparation.uncoveredPaths.length)
    throw new Error("Reconciliation provider coverage is incomplete");
  if (
    preparation?.kind === "provider" &&
    preparation.result.facts.providerRuns.some((run) => run.status === "failed")
  )
    throw new Error("Failed provider results cannot publish");
  const removedPaths = [
    ...new Set((request.removedPaths ?? []).map(normalizePath)),
  ];
  const sources = preparation?.files ?? [];
  const paths = [
    ...sources.map((file) => normalizePath(file.path)),
    ...removedPaths,
  ];
  if (!paths.length || new Set(paths).size !== paths.length)
    throw new Error(
      "Reconciliation requires distinct changed or removed files",
    );
  if (
    request.claim.repoId !== request.repoId ||
    paths.some(
      (path) => !request.claim.files.some((file) => file.filePath === path),
    )
  )
    throw new Error("Publication scope is not owned by its queue claim");
  for (const source of sources) {
    const input = request.claim.files.find(
      (file) => file.filePath === source.path,
    )!.input;
    if (
      input.kind === "removed" ||
      (input.kind === "saved" && input.sourceHash !== source.contentHash)
    )
      throw new ReconcilePublicationStaleError(
        "Prepared source does not belong to the saved generation",
      );
  }
  return withExclusiveReadConnection((conn) =>
    withReadOnlyTransaction(conn, async () => {
      const { version, derived, parser } = await readBaseline(
        conn,
        request.repoId,
      );
      const revision = derived.graphIntegrityRevision!;
      if (
        version.versionId !== request.baseline.versionId ||
        revision !== request.baseline.revision ||
        parser.coverageDigest !== request.baseline.coverageDigest
      )
        throw new ReconcilePublicationStaleError(
          "Reconciliation preparation lost graph ownership",
        );
      if (
        preparation?.kind === "parser" &&
        preparation.patches.some(
          (patch) =>
            patch.graphVersionId !== version.versionId ||
            patch.graphRevision !== revision,
        )
      )
        throw new Error("Parser preparation lost graph ownership");
      const files = (
        await Promise.all(
          paths.map((path) => db.getFileByRepoPath(conn, request.repoId, path)),
        )
      ).filter((file): file is db.FileRow => file !== null);
      const symbols = (
        await Promise.all(
          files.map((file) => db.getSymbolsByFile(conn, file.fileId)),
        )
      )
        .flat()
        .filter((symbol) => symbol.repoId === request.repoId);
      const fileIds = files.map((file) => file.fileId);
      const references = await db.getSymbolReferencesByFileIds(
        conn,
        request.repoId,
        fileIds,
      );
      const parserStates = (
        await Promise.all(
          fileIds.map((id) => db.getFileParserState(conn, request.repoId, id)),
        )
      ).filter((row) => row !== null);
      const oldManifests = await Promise.all(
        files.map(async (file) => {
          const manifest = await db.getGraphIntegrityFileState(
            conn,
            request.repoId,
            file.fileId,
          );
          if (
            !manifest ||
            !graphIntegrityFileStateMatchesDigest(
              manifest,
              createGraphIntegrityFileDigest({
                fileId: file.fileId,
                relPath: file.relPath,
                symbols: symbols.filter(
                  (symbol) => symbol.fileId === file.fileId,
                ),
              }),
            )
          )
            throw new Error(
              "Reconciliation file manifest does not match its owned symbols",
            );
          return manifest;
        }),
      );
      const rows: ProviderFirstGraphRows =
        preparation?.kind === "provider"
          ? structuredClone(preparation.result.rows)
          : {
              files: preparation?.patches.map((patch) => patch.rows.file) ?? [],
              symbols:
                preparation?.patches.flatMap((patch) => patch.rows.symbols) ??
                [],
              edges:
                preparation?.patches.flatMap((patch) => patch.rows.edges) ?? [],
              externalSymbols: [],
              changedFileIds: new Set(),
            };
      // Existing durable IDs are authoritative; provider hashes must not split file ownership.
      for (const file of rows.files) {
        const old = files.find((item) => item.relPath === file.relPath);
        const source = sources.find((item) => item.path === file.relPath);
        if (
          !source ||
          source.contentHash !== file.contentHash ||
          source.size !== file.byteSize ||
          file.repoId !== request.repoId
        )
          throw new Error("Prepared provider file does not match saved input");
        if (old && old.fileId !== file.fileId) {
          for (const symbol of rows.symbols)
            if (symbol.fileId === file.fileId) symbol.fileId = old.fileId;
          file.fileId = old.fileId;
        }
      }
      rows.changedFileIds = new Set([
        ...fileIds,
        ...rows.files.map((file) => file.fileId),
      ]);
      const outsideDefinitions = await db.getSymbolsByIds(
        conn,
        [...rows.externalSymbols, ...rows.symbols].map(
          (symbol) => symbol.symbolId,
        ),
      );
      const ownedDefinitions = await db.getRepoSymbolFileIdsByIds(
        conn,
        request.repoId,
        [...rows.symbols, ...rows.externalSymbols].map(
          (symbol) => symbol.symbolId,
        ),
      );
      for (const symbol of rows.symbols) {
        const existing = ownedDefinitions.get(symbol.symbolId);
        if (existing && !rows.changedFileIds.has(existing))
          throw new Error(
            "Provider symbol replacement requires its existing owning file in the prepared unit",
          );
      }
      const sharedDefinitions = rows.externalSymbols.flatMap((symbol) => {
        const actual = outsideDefinitions.get(symbol.symbolId);
        return actual && !ownedDefinitions.has(symbol.symbolId) ? [actual] : [];
      });
      const sharedOwnedIds = await db.getSymbolIdsInOtherRepos(
        conn,
        request.repoId,
        rows.symbols.map((symbol) => symbol.symbolId),
      );
      // A scoped provider may describe an unselected definition as external. Keep
      // that definition's actual graph ownership instead of overwriting it.
      rows.externalSymbols = rows.externalSymbols.filter(
        (symbol) => !outsideDefinitions.has(symbol.symbolId),
      );
      const sharedExternalIds = await db.getSymbolIdsInOtherRepos(
        conn,
        request.repoId,
        rows.externalSymbols.map((symbol) => symbol.symbolId),
      );
      const sharedExternals = await db.getProviderExternalSymbolsByIds(
        conn,
        null,
        [...sharedExternalIds],
      );
      for (const symbol of rows.externalSymbols) {
        if (!sharedExternalIds.has(symbol.symbolId)) continue;
        const actual = sharedExternals.get(symbol.symbolId);
        if (
          !actual ||
          JSON.stringify(
            externalTuple({ ...actual, repoId: request.repoId }),
          ) !== JSON.stringify(externalTuple(symbol))
        ) {
          throw new Error(
            "Reconciliation cannot replace incompatible shared fileless Symbol facts within a single repository",
          );
        }
      }
      const allSymbolIds = [
        ...new Set(
          [...symbols, ...rows.symbols].map((symbol) => symbol.symbolId),
        ),
      ];
      const outgoing = [
        ...(await db.getEdgesFromSymbols(conn, allSymbolIds)).values(),
      ]
        .flat()
        .filter((edge) => edge.repoId === request.repoId);
      const incoming = [
        ...(
          await db.getEdgesToSymbolsInRepo(conn, request.repoId, allSymbolIds)
        ).values(),
      ].flat();
      const oldEdges = uniqueEdges([...outgoing, ...incoming]);
      const oldIds = new Set(symbols.map((symbol) => symbol.symbolId));
      const newIds = new Set(rows.symbols.map((symbol) => symbol.symbolId));
      // Replacement retires old nodes. Restore outside callers of surviving identities.
      rows.edges = uniqueEdges([
        ...incoming.filter(
          (edge) =>
            !oldIds.has(edge.fromSymbolId) && newIds.has(edge.toSymbolId),
        ),
        ...rows.edges,
      ]);
      const nextReferences =
        preparation?.kind === "parser"
          ? preparation.patches.flatMap((patch) => patch.rows.references)
          : rows.files.flatMap((file) =>
              buildSymbolReferences(
                sources.find((source) => source.path === file.relPath)!.content,
                request.repoId,
                file.fileId,
              ),
            );
      const nextParserStates =
        preparation?.kind === "parser"
          ? preparation.patches.map((patch) => patch.rows.parserState)
          : parserStates.filter((state) =>
              rows.files.some((file) => file.fileId === state.fileId),
            );
      const previousFilelessRefs = oldManifests.flatMap((manifest) =>
        parseGraphIntegrityFilelessReferences(manifest.filelessReferencesJson),
      );
      const filelessSymbols = [
        ...createGraphIntegrityFilelessSymbols(rows),
        ...sharedDefinitions.map((symbol) =>
          canonicalizePersistedGraphIntegritySymbol({ ...symbol, fileId: "" }),
        ),
      ];
      const filelessIds = [
        ...new Set([
          ...previousFilelessRefs.map((ref) => ref[0]),
          ...filelessSymbols.map((symbol) => symbol.symbolId),
        ]),
      ];
      const fileless = new Map(
        (
          await getGraphIntegrityFilelessStates(
            conn,
            request.repoId,
            filelessIds,
          )
        ).map((state) => [state.symbolId, state]),
      );
      const nextManifests = rows.files.map((file) => {
        const ownSymbols = rows.symbols.filter(
          (symbol) => symbol.fileId === file.fileId,
        );
        const ownIds = new Set(ownSymbols.map((symbol) => symbol.symbolId));
        const ownEdges = rows.edges.filter(
          (edge) =>
            ownIds.has(edge.fromSymbolId) ||
            (filelessIds.includes(edge.fromSymbolId) &&
              ownIds.has(edge.toSymbolId)),
        );
        return createGraphIntegrityFileState(
          request.repoId,
          file.fileId,
          file.relPath,
          ownSymbols,
          createGraphIntegrityFilelessReferenceTuples(
            createGraphIntegrityFilelessEdgeReferences(ownEdges, filelessIds, {
              trackSources: true,
            }),
            filelessSymbols,
            fileless,
          ),
        );
      });
      const nextFilelessRefs = nextManifests.flatMap((manifest) =>
        parseGraphIntegrityFilelessReferences(manifest.filelessReferencesJson),
      );
      const delta = createGraphIntegrityFilelessDelta(
        request.repoId,
        fileless,
        previousFilelessRefs,
        nextFilelessRefs,
        derived.graphIntegrityFilelessPruningSupported!,
      );
      const provenance =
        preparation?.kind === "provider"
          ? providerFactsToSemanticProvenanceRecords(preparation.result.facts)
          : { providerRuns: [], diagnostics: [] };
      const authorities: ReconcileFileAuthority[] =
        preparation?.kind === "provider"
          ? rows.files.map((file) => {
              const facts = preparation.result.facts;
              return {
                repoId: request.repoId,
                fileId: file.fileId,
                relPath: file.relPath,
                graphVersionId: version.versionId,
                sourceHash: file.contentHash,
                configHash: preparation.configurationHash,
                authorityJson: JSON.stringify({
                  providers: sorted(
                    facts.files
                      .filter((fact) => fact.relPath === file.relPath)
                      .map((fact) => [
                        fact.providerType,
                        fact.providerId,
                        fact.providerVersion ?? "",
                      ]),
                  ),
                  coverage: sorted(
                    facts.coverage
                      .filter((fact) => fact.relPath === file.relPath)
                      .map(
                        ({
                          generationId: _generationId,
                          emittedAt: _emittedAt,
                          ...fact
                        }) => fact,
                      ),
                  ),
                }),
              };
            })
          : [];
      const priorAuthorities = await readReconcileFileAuthorities(
        conn,
        request.repoId,
        [...rows.changedFileIds],
      );
      const currentExternals = await db.getProviderExternalSymbolsByIds(
        conn,
        request.repoId,
        [...rows.externalSymbols, ...sharedDefinitions].map(
          (symbol) => symbol.symbolId,
        ),
      );
      const externalUnchanged = rows.externalSymbols.every((symbol) => {
        const current = currentExternals.get(symbol.symbolId);
        return (
          current !== undefined &&
          JSON.stringify(externalTuple(current)) ===
            JSON.stringify(externalTuple(symbol))
        );
      });
      const same = (a: readonly unknown[], b: readonly unknown[]) =>
        JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
      const checks = [
        externalUnchanged,
        sharedDefinitions.every((symbol) =>
          currentExternals.has(symbol.symbolId),
        ),
        same(files.map(fileTuple), rows.files.map(fileTuple)),
        same(symbols.map(symbolTuple), rows.symbols.map(symbolTuple)),
        same(oldEdges.map(edgeTuple), rows.edges.map(edgeTuple)),
        same(
          references.map(referenceTuple),
          nextReferences.map(referenceTuple),
        ),
        same(parserStates, nextParserStates),
        same(oldManifests, nextManifests),
        delta.deleteSymbolIds.length === 0,
        delta.upserts.every(
          (row) => hashValue(row) === hashValue(fileless.get(row.symbolId)),
        ),
        same(authorities, [...priorAuthorities.values()]),
      ];
      const noOp = checks.every(Boolean);
      // One repository cannot publish new global facts for another owner's definition.
      // Membership-only deletion is safe; changed shared definitions need coherent ownership.
      if (
        sharedOwnedIds.size &&
        (!same(
          symbols
            .filter((symbol) => sharedOwnedIds.has(symbol.symbolId))
            .map(symbolTuple),
          rows.symbols
            .filter((symbol) => sharedOwnedIds.has(symbol.symbolId))
            .map(symbolTuple),
        ) ||
          !same(
            oldEdges
              .filter((edge) => sharedOwnedIds.has(edge.fromSymbolId))
              .map(edgeTuple),
            rows.edges
              .filter((edge) => sharedOwnedIds.has(edge.fromSymbolId))
              .map(edgeTuple),
          ))
      )
        throw new Error(
          "Reconciliation cannot replace changed shared Symbol definitions or outgoing edges within a single repository",
        );
      const frontier = {
        touchedSymbolIds: allSymbolIds,
        dependentSymbolIds: [] as string[],
        dependentFilePaths: [] as string[],
        importedFilePaths: [] as string[],
        invalidations: [
          "metrics",
          "clusters",
          "processes",
        ] as ReconcileClaim["frontier"]["invalidations"],
      };
      for (const path of paths) {
        const item = await buildDependencyFrontier({
          conn,
          repoId: request.repoId,
          touchedSymbolIds: allSymbolIds,
          outgoingEdges: rows.edges,
          currentFilePath: path,
        });
        frontier.dependentSymbolIds.push(...item.dependentSymbolIds);
        frontier.dependentFilePaths.push(...item.dependentFilePaths);
        frontier.importedFilePaths.push(...item.importedFilePaths);
      }
      frontier.dependentSymbolIds = [...new Set(frontier.dependentSymbolIds)];
      frontier.dependentFilePaths = [
        ...new Set(frontier.dependentFilePaths),
      ].filter((path) => !paths.includes(path));
      frontier.importedFilePaths = [
        ...new Set(frontier.importedFilePaths),
      ].filter((path) => !paths.includes(path));
      return {
        request,
        rows,
        sharedDefinitions,
        sharedOwnedIds,
        sharedOwnedEdges: oldEdges.filter((edge) =>
          sharedOwnedIds.has(edge.fromSymbolId),
        ),
        sharedExternalIds,
        sharedExternals,
        sharedDefinitionBaselines: [
          ...sharedDefinitions,
          ...[...sharedOwnedIds].flatMap((id) => {
            const actual = outsideDefinitions.get(id);
            return actual ? [actual] : [];
          }),
        ],
        sources: structuredClone(sources),
        dependencies: structuredClone(preparation?.dependencyInputs ?? []),
        removedPaths,
        versionId: version.versionId,
        revision,
        parser,
        nextParserStates,
        parserChanged: !same(parserStates, nextParserStates),
        membershipChanged: !same(
          fileIds,
          rows.files.map((file) => file.fileId),
        ),
        nextReferences,
        nextManifests,
        delta,
        provenance,
        authorities,
        noOp,
        frontier,
        removedFileIds: files
          .filter((file) => removedPaths.includes(file.relPath))
          .map((file) => file.fileId),
      };
    }),
  );
}

export type PreparedReconcilePublication = Awaited<
  ReturnType<typeof prepareReconcilePublication>
>;

/** Admission ordering keeps both provider work and writer queueing outside save acceptance. */
export async function publishReconcile(
  prepared: PreparedReconcilePublication,
  observer?: { afterRows?(): void | Promise<void> },
): Promise<ReconcilePublicationOutcome> {
  const { request } = prepared;
  const current = () =>
    request.queue.isCurrent(request.claim) &&
    isRepoEpochCurrent(request.repoId, request.epoch);
  if (!current()) return { kind: "stale" };
  let publicationStarted = false;
  const finishPublication = (phase: "completed" | "failed") => {
    if (!publicationStarted) return;
    publicationStarted = false;
    publishingRepos.delete(request.repoId);
    notifyPublication({ repoId: request.repoId, epoch: request.epoch, phase });
  };
  const outcome = await withRepoMutation(
    request.repoId,
    () =>
      withRepoWriteHeavyLock(request.repoId, () =>
        withWriteConn((conn) =>
          request.queue.withPublicationFence(
            request.repoId,
            async (): Promise<ReconcilePublicationOutcome> => {
              if (!current() || !(await request.assertCurrent()))
                return { kind: "stale" };
              for (const source of [
                ...prepared.sources,
                ...prepared.dependencies,
              ]) {
                const disk = await readRepositoryFileBounded(
                  request.repoRoot,
                  source.path,
                  64 * 1024 * 1024,
                );
                if (
                  disk.kind !== "ok" ||
                  hash("sha256", disk.content, "hex") !== source.contentHash
                )
                  return { kind: "stale" };
              }
              for (const path of prepared.removedPaths) {
                try {
                  await lstat(
                    getAbsolutePathFromRepoRoot(request.repoRoot, path),
                  );
                  return { kind: "stale" };
                } catch (error) {
                  if (
                    !(error instanceof Error) ||
                    !("code" in error) ||
                    error.code !== "ENOENT"
                  )
                    return { kind: "stale" };
                }
              }
              if (!current() || !(await request.assertCurrent()))
                return { kind: "stale" };
              return withTransaction<ReconcilePublicationOutcome>(
                conn,
                async (tx) => {
                  const version = await db.getLatestVersion(tx, request.repoId);
                  const derived = await getDerivedStateFromConnection(
                    tx,
                    request.repoId,
                  );
                  const parser = await db.getRepoParserState(
                    tx,
                    request.repoId,
                  );
                  if (
                    version?.versionId !== prepared.versionId ||
                    derived?.graphIntegrityRevision !== prepared.revision ||
                    parser?.coverageDigest !== prepared.parser.coverageDigest ||
                    !parserCoverageMatchesCurrentGraph(
                      derived,
                      prepared.versionId,
                      parser,
                    )
                  )
                    return { kind: "stale" };
                  // Another repository can change a global target without advancing our revision.
                  const sharedOwnedNow = await db.getSymbolIdsInOtherRepos(
                    tx,
                    request.repoId,
                    prepared.rows.symbols.map((symbol) => symbol.symbolId),
                  );
                  if (
                    JSON.stringify([...sharedOwnedNow].sort()) !==
                    JSON.stringify([...prepared.sharedOwnedIds].sort())
                  )
                    return { kind: "stale" };
                  const sharedEdgesNow = [
                    ...(
                      await db.getEdgesFromSymbols(tx, [
                        ...prepared.sharedOwnedIds,
                      ])
                    ).values(),
                  ]
                    .flat()
                    .filter((edge) => edge.repoId === request.repoId);
                  if (
                    JSON.stringify(sorted(sharedEdgesNow.map(edgeTuple))) !==
                    JSON.stringify(
                      sorted(prepared.sharedOwnedEdges.map(edgeTuple)),
                    )
                  )
                    return { kind: "stale" };
                  const externalSharingNow = await db.getSymbolIdsInOtherRepos(
                    tx,
                    request.repoId,
                    prepared.rows.externalSymbols.map(
                      (symbol) => symbol.symbolId,
                    ),
                  );
                  if (
                    JSON.stringify([...externalSharingNow].sort()) !==
                    JSON.stringify([...prepared.sharedExternalIds].sort())
                  )
                    return { kind: "stale" };
                  const externalFactsNow =
                    await db.getProviderExternalSymbolsByIds(tx, null, [
                      ...prepared.sharedExternalIds,
                    ]);
                  for (const [id, before] of prepared.sharedExternals) {
                    const actual = externalFactsNow.get(id);
                    if (
                      !actual ||
                      JSON.stringify(
                        externalTuple({ ...actual, repoId: "" }),
                      ) !==
                        JSON.stringify(externalTuple({ ...before, repoId: "" }))
                    )
                      return { kind: "stale" };
                  }
                  const currentShared = await db.getSymbolsByIds(
                    tx,
                    prepared.sharedDefinitionBaselines.map(
                      (symbol) => symbol.symbolId,
                    ),
                  );
                  if (
                    prepared.sharedDefinitionBaselines.some((symbol) => {
                      const current = currentShared.get(symbol.symbolId);
                      const tuple = (value: db.SymbolRow) =>
                        symbolTuple({ ...value, repoId: "", fileId: "" });
                      return (
                        !current ||
                        JSON.stringify(tuple(current)) !==
                          JSON.stringify(tuple(symbol))
                      );
                    })
                  )
                    return { kind: "stale" };
                  if (prepared.noOp) return { kind: "noop" };
                  const revision =
                    await advanceGraphIntegrityRevisionInTransaction(
                      tx,
                      request.repoId,
                      prepared.versionId,
                      prepared.revision,
                    );
                  if (revision === null) return { kind: "stale" };
                  publicationStarted = true;
                  publishingRepos.add(request.repoId);
                  notifyPublication({
                    repoId: request.repoId,
                    epoch: request.epoch,
                    phase: "started",
                  });
                  await materializeProviderRowsInTransaction(
                    tx,
                    request.repoId,
                    prepared.rows,
                  );
                  await db.attachSymbolRepoMembershipsInTransaction(
                    tx,
                    request.repoId,
                    prepared.sharedDefinitions.map((symbol) => symbol.symbolId),
                  );
                  await db.deleteFilesByIds(tx, prepared.removedFileIds);
                  await db.insertSymbolReferences(tx, prepared.nextReferences);
                  for (const run of prepared.provenance.providerRuns)
                    await mergeSemanticProviderRun(tx, run);
                  await mergeSemanticDiagnostics(
                    tx,
                    prepared.provenance.diagnostics,
                  );
                  await deleteReconcileFileAuthoritiesInTransaction(tx, [
                    ...prepared.rows.changedFileIds,
                  ]);
                  await writeReconcileFileAuthoritiesInTransaction(
                    tx,
                    prepared.authorities,
                  );
                  await observer?.afterRows?.();
                  for (const id of prepared.removedFileIds)
                    await db.deleteGraphIntegrityFileStateInTransaction(
                      tx,
                      request.repoId,
                      id,
                    );
                  for (const manifest of prepared.nextManifests)
                    await db.upsertGraphIntegrityFileStateInTransaction(
                      tx,
                      manifest,
                    );
                  await applyGraphIntegrityFilelessDeltaInTransaction(
                    tx,
                    request.repoId,
                    prepared.delta,
                  );
                  await db.upsertFileParserStatesInTransaction(
                    tx,
                    prepared.nextParserStates,
                  );
                  const coverage =
                    prepared.parserChanged || prepared.membershipChanged
                      ? await db.summarizeParserCoverageInTransaction(
                          tx,
                          request.repoId,
                        )
                      : {
                          coverageState: prepared.parser.coverageState,
                          coverageDigest: prepared.parser.coverageDigest,
                        };
                  await db.upsertRepoParserStateInTransaction(tx, {
                    ...prepared.parser,
                    ...coverage,
                    graphRevision: revision,
                  });
                  // Preserve any independently outstanding semantic work while dirtying changed inputs.
                  await markDerivedStateDirtyInTransaction(
                    tx,
                    request.repoId,
                    prepared.versionId,
                    {
                      clusters: true,
                      processes: true,
                      algorithms: true,
                      summaries: true,
                      embeddings: true,
                    },
                  );
                  return {
                    kind: "published",
                    revision,
                    frontier: prepared.frontier,
                  };
                },
              )
                .then((result) => {
                  // Commit/native settlement completed while this owner still holds the fence.
                  if (result.kind === "published") {
                    symbolCardCache.invalidateRepo(request.repoId);
                    finishPublication("completed");
                  }
                  return result;
                })
                .finally(() => {
                  // Rollback also settles before the next publisher can acquire this fence.
                  finishPublication("failed");
                });
            },
          ),
        ),
      ),
    { expectedEpoch: request.epoch },
  );
  if (outcome.kind === "published") {
    notifyGraphIntegrityVerifier(request.repoId);
  }
  return outcome;
}
