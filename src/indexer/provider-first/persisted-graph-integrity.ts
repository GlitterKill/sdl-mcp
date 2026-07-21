import { createHash, type Hash } from "node:crypto";

import type { Connection } from "kuzu";

import { DatabaseError } from "../../domain/errors.js";
import {
  advanceGraphIntegrityRevisionInTransaction,
  getDerivedState,
  graphIntegrityIsVerifiedForVersion,
  markCurrentGraphIntegrityRevisionFailed,
  markGraphIntegrityFailedIfVerifying,
  markGraphIntegrityVerifying,
  markGraphIntegrityVerifiedIfVerifying,
  initializeGraphIntegrityRevisionIfVerifying,
  initializeGraphIntegrityVersionInTransaction,
  markUnrevisionedGraphIntegrityFailedIfVerifying,
} from "../../db/ladybug-derived-state.js";
import { classifyDependencyTarget } from "../../db/symbol-placeholders.js";
import {
  getPersistedGraphIntegrityOtherRepoSymbolCount,
  getPersistedGraphIntegritySourceReferenceCounts,
  getPersistedGraphIntegritySymbolPage,
  GraphIntegrityManifestValidationError,
  listGraphIntegrityFilelessStates,
  listGraphIntegrityFileStates,
  replaceGraphIntegrityManifestInTransaction,
  type GraphIntegrityFileStateRecord,
  type GraphIntegrityFilelessDelta,
  type GraphIntegrityFilelessStateRecord,
  type GraphIntegritySymbolCursor,
} from "../../db/ladybug-graph-integrity.js";
import {
  getLadybugConn,
  withExclusiveReadConnection,
  withWriteConn,
} from "../../db/ladybug.js";
import { withReadOnlyTransaction } from "../../db/ladybug-core.js";
import * as ladybugDb from "../../db/ladybug-queries.js";
import type { EdgeRow, SymbolRow } from "../../db/ladybug-queries.js";
import { logger } from "../../util/logger.js";
import { normalizePath } from "../../util/paths.js";
import type {
  ProviderFirstExternalSymbolRow,
  ProviderFirstGraphRows,
} from "./materializer.js";

const GRAPH_INTEGRITY_PAGE_SIZE = 512;
const GRAPH_INTEGRITY_QUERY_PAGE_SIZE = 2_048;
const GRAPH_INTEGRITY_FILE_ID_CHUNK_SIZE = 256;
const DIAGNOSTIC_STRING_LIMIT = 160;
export const GRAPH_INTEGRITY_VERIFICATION_FAILURE =
  "Persisted graph integrity verification failed";
const INCREMENTAL_BASELINE_ERROR =
  'Incremental indexing requires a verified graph integrity baseline. Run sdl.index.refresh with mode:"full" first. If full verification also fails, stop SDL-MCP, delete the configured .lbug database directory, and rebuild from source.';
const FILELESS_SENTINEL = "";
interface ActiveGraphIntegrityVerification {
  versionId: string;
  revision: number | null;
}

const activeVerifications = new Map<
  string,
  ActiveGraphIntegrityVerification
>();

export type GraphIntegrityCanonicalSymbol = Pick<
  SymbolRow,
  | "symbolId"
  | "fileId"
  | "name"
  | "kind"
  | "language"
  | "rangeStartLine"
  | "rangeStartCol"
  | "rangeEndLine"
  | "rangeEndCol"
  | "signatureJson"
  | "source"
  | "scipSymbol"
  | "astFingerprint"
  | "symbolStatus"
  | "external"
  | "placeholderKind"
  | "placeholderTarget"
>;

type CanonicalSymbol = GraphIntegrityCanonicalSymbol;

export interface GraphIntegrityEdgeReference {
  /** Fileless endpoint whose liveness this contribution establishes. */
  filelessSymbolId: string;
  /** Present only for incremental current-run deltas that pass 2 may replace. */
  sourceSymbolId: string | null;
  edgeType: string;
  direction: "incoming" | "outgoing";
  referenceCount: number;
}

export type GraphIntegrityFilelessReferenceTuple = readonly [
  filelessSymbolId: string,
  canonicalSymbolJson: string,
  sourceSymbolId: string | null,
  edgeType: string,
  direction: "incoming" | "outgoing",
  referenceCount: number,
];

type GraphIntegrityCanonicalSymbolTuple = readonly [
  symbolId: string,
  fileId: string,
  relPath: string,
  name: string,
  signatureJson: string,
  kind: string,
  language: string,
  rangeStartLine: number,
  rangeStartCol: number,
  rangeEndLine: number,
  rangeEndCol: number,
  source: string,
  scipSymbol: string,
  astFingerprint: string,
  symbolStatus: "real" | "unresolved" | "external",
  external: boolean,
  placeholderKind: string,
  placeholderTarget: string,
];

export interface GraphIntegrityEdgeWrite {
  symbolIdsToRefresh: readonly string[];
  edges: readonly EdgeRow[];
}

export interface GraphIntegrityPass1Accumulator {
  symbolMapFileUpdates: ReadonlyMap<
    string,
    {
      readonly fileId: string;
      readonly symbols: readonly Pick<SymbolRow, "symbolId">[];
    }
  >;
  graphIntegrityFiles: Map<string, GraphIntegrityFileDigest>;
  graphIntegrityFilelessSymbols: Map<string, CanonicalSymbol>;
  graphIntegrityFilelessReferences: Map<string, GraphIntegrityEdgeReference>;
}

export interface GraphIntegrityPageDigest {
  symbolCount: number;
  firstSymbolId: string;
  lastSymbolId: string;
  digest: string;
}

export interface GraphIntegrityFileDigest {
  fileId: string;
  relPath: string;
  symbolCount: number;
  digest: string;
  pages: GraphIntegrityPageDigest[];
}

export interface GraphIntegrityExpectation {
  symbolCount: number;
  digest: string;
  files: GraphIntegrityFileDigest[];
}

export interface GraphIntegrityMismatchDiagnostic {
  expectedCount: number;
  actualCount: number;
  expectedDigest: string;
  actualDigest: string;
  fileIndex: number;
  expectedFile: BoundedFileDiagnostic | null;
  actualFile: BoundedFileDiagnostic | null;
  pageIndex?: number;
  expectedPage?: BoundedPageDiagnostic | null;
  actualPage?: BoundedPageDiagnostic | null;
}

interface BoundedFileDiagnostic {
  fileId: string;
  relPath: string;
  symbolCount: number;
  digest: string;
}

interface BoundedPageDiagnostic {
  symbolCount: number;
  firstSymbolId: string;
  lastSymbolId: string;
  digest: string;
}

interface MutableFileDigest {
  fileId: string;
  relPath: string;
  symbolCount: number;
  digest: Hash;
  pageDigest: Hash;
  pageSymbolCount: number;
  pageFirstSymbolId: string;
  pageLastSymbolId: string;
  pages: GraphIntegrityPageDigest[];
}

export class GraphIntegrityVerificationError extends Error {
  constructor() {
    super(GRAPH_INTEGRITY_VERIFICATION_FAILURE);
  }
}

export interface GraphIntegrityVerificationOptions {
  persistFailureState?: typeof markGraphIntegrityFailedIfVerifying;
  /** Test barrier used to prove a newer state wins after the final read. */
  afterCapture?: () => Promise<void>;
  /** Exact synchronous session revision; never adopt a newer durable revision. */
  expectedRevision?: number;
}

interface GraphIntegrityReferenceCount {
  symbolId: string;
  edgeType: string;
  referenceCount: number;
}

/**
 * Tracks only the aggregate liveness information needed to predict placeholder
 * pruning. Verified baseline edges never become a second in-memory graph:
 * counts are grouped by fileless target/type, with extra buckets only for
 * files this run replaces. Exact source detail is limited to current-run
 * incremental deltas because pass 2 can replace those sources again.
 */
export class GraphIntegrityFilelessLivenessLedger {
  private readonly counts = new Map<string, Map<string, number>>();
  private readonly totals = new Map<string, number>();
  private readonly baselineByFile = new Map<
    string,
    Map<string, GraphIntegrityReferenceCount>
  >();
  private readonly currentBySource = new Map<
    string,
    Map<string, Map<string, number>>
  >();
  private readonly currentSourcesByTarget = new Map<
    string,
    Map<string, Map<string, number>>
  >();
  private readonly preparedCurrentSourceTypes = new Set<string>();
  private pruningSupported = true;

  constructor(private readonly trackCurrentSources: boolean) {}

  get canPrune(): boolean {
    return this.pruningSupported;
  }

  disablePruning(): void {
    this.pruningSupported = false;
  }

  seedReferenceCount(reference: GraphIntegrityReferenceCount): void {
    this.adjust(reference.symbolId, reference.edgeType, reference.referenceCount);
  }

  seedFileReferenceCount(
    fileId: string,
    reference: GraphIntegrityReferenceCount,
  ): void {
    let references = this.baselineByFile.get(fileId);
    if (!references) {
      references = new Map();
      this.baselineByFile.set(fileId, references);
    }
    const key = referenceCountKey(reference.symbolId, reference.edgeType);
    const previous = references.get(key);
    references.set(key, {
      ...reference,
      referenceCount:
        (previous?.referenceCount ?? 0) + reference.referenceCount,
    });
  }

  removeFile(fileId: string): void {
    const references = this.baselineByFile.get(fileId);
    if (!references) return;
    for (const reference of references.values()) {
      this.adjust(
        reference.symbolId,
        reference.edgeType,
        -reference.referenceCount,
      );
    }
    this.baselineByFile.delete(fileId);
  }

  add(contribution: GraphIntegrityEdgeReference): void {
    if (contribution.direction === "outgoing") {
      // Product writers do not emit dependency edges from fileless symbols.
      // Retaining placeholders is safer than approximating an unknown shape.
      this.disablePruning();
      return;
    }
    this.adjust(
      contribution.filelessSymbolId,
      contribution.edgeType,
      contribution.referenceCount,
    );
    if (!this.trackCurrentSources || contribution.sourceSymbolId === null) {
      return;
    }
    this.markCurrentSourcePrepared(
      contribution.sourceSymbolId,
      contribution.edgeType,
    );
    addNestedReferenceCount(
      this.currentBySource,
      contribution.sourceSymbolId,
      contribution.edgeType,
      contribution.filelessSymbolId,
      contribution.referenceCount,
    );
    addNestedReferenceCount(
      this.currentSourcesByTarget,
      contribution.filelessSymbolId,
      contribution.edgeType,
      contribution.sourceSymbolId,
      contribution.referenceCount,
    );
  }

  remove(contribution: GraphIntegrityEdgeReference): void {
    if (contribution.direction === "outgoing") {
      this.disablePruning();
      return;
    }
    this.adjust(
      contribution.filelessSymbolId,
      contribution.edgeType,
      -contribution.referenceCount,
    );
  }

  entries(): IterableIterator<[string, number]> {
    return this.totals.entries();
  }

  seedCurrentSourceReference(
    sourceSymbolId: string,
    reference: GraphIntegrityReferenceCount,
  ): void {
    this.markCurrentSourcePrepared(sourceSymbolId, reference.edgeType);
    addNestedReferenceCount(
      this.currentBySource,
      sourceSymbolId,
      reference.edgeType,
      reference.symbolId,
      reference.referenceCount,
    );
    addNestedReferenceCount(
      this.currentSourcesByTarget,
      reference.symbolId,
      reference.edgeType,
      sourceSymbolId,
      reference.referenceCount,
    );
  }

  currentSourceIsPrepared(sourceSymbolId: string, edgeType: string): boolean {
    return this.preparedCurrentSourceTypes.has(
      currentSourceTypeKey(sourceSymbolId, edgeType),
    );
  }

  markCurrentSourcePrepared(sourceSymbolId: string, edgeType: string): void {
    this.preparedCurrentSourceTypes.add(
      currentSourceTypeKey(sourceSymbolId, edgeType),
    );
  }

  removeOutgoing(sourceSymbolIds: readonly string[], edgeType: string): void {
    for (const sourceSymbolId of sourceSymbolIds) {
      const byType = this.currentBySource.get(sourceSymbolId);
      const targets = byType?.get(edgeType);
      if (!targets) continue;
      for (const [targetSymbolId, referenceCount] of targets) {
        this.adjust(targetSymbolId, edgeType, -referenceCount);
        removeNestedReferenceCount(
          this.currentSourcesByTarget,
          targetSymbolId,
          edgeType,
          sourceSymbolId,
        );
      }
      byType!.delete(edgeType);
      if (byType!.size === 0) this.currentBySource.delete(sourceSymbolId);
    }
  }

  removeTargets(targetSymbolIds: readonly string[], edgeType: string): void {
    for (const targetSymbolId of targetSymbolIds) {
      this.setCount(targetSymbolId, edgeType, 0);
      const byType = this.currentSourcesByTarget.get(targetSymbolId);
      const sources = byType?.get(edgeType);
      if (sources) {
        for (const sourceSymbolId of sources.keys()) {
          removeNestedReferenceCount(
            this.currentBySource,
            sourceSymbolId,
            edgeType,
            targetSymbolId,
          );
        }
        byType!.delete(edgeType);
        if (byType!.size === 0) {
          this.currentSourcesByTarget.delete(targetSymbolId);
        }
      }
    }
  }

  isReferenced(symbolId: string): boolean {
    return (this.totals.get(symbolId) ?? 0) > 0;
  }

  private adjust(symbolId: string, edgeType: string, delta: number): void {
    const previous = this.counts.get(symbolId)?.get(edgeType) ?? 0;
    this.setCount(symbolId, edgeType, Math.max(0, previous + delta));
  }

  private setCount(symbolId: string, edgeType: string, count: number): void {
    const byType = this.counts.get(symbolId);
    const previous = byType?.get(edgeType) ?? 0;
    if (previous === count) return;
    if (count === 0) {
      byType?.delete(edgeType);
      if (byType?.size === 0) this.counts.delete(symbolId);
    } else {
      const next = byType ?? new Map<string, number>();
      next.set(edgeType, count);
      this.counts.set(symbolId, next);
    }
    const total = Math.max(0, (this.totals.get(symbolId) ?? 0) + count - previous);
    if (total === 0) this.totals.delete(symbolId);
    else this.totals.set(symbolId, total);
  }
}

/**
 * Keeps the expected graph as compact file/page digests while indexer.ts
 * sequences provider-first or legacy persistence.
 */
export class PersistedGraphIntegritySession {
  private versionId: string | undefined;
  private files: Map<string, GraphIntegrityFileDigest> | undefined;
  private filelessSymbols: Map<string, CanonicalSymbol> | undefined;
  private filelessLiveness: GraphIntegrityFilelessLivenessLedger | undefined;
  private readonly sourceFileIdBySymbolId = new Map<string, string>();
  private readonly filelessReferencesByFileId = new Map<
    string,
    Map<string, GraphIntegrityEdgeReference>
  >();
  private stagedRevision: number | undefined;
  private baselineRevision: number | undefined;
  private activeVerification: ActiveGraphIntegrityVerification | undefined;
  private pass2ApplyChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly repoId: string,
    private readonly mode: "full" | "incremental",
    private readonly enabled: boolean,
  ) {}

  get plannedVersionId(): string | undefined {
    return this.versionId;
  }

  reserveVersionId(): string {
    this.versionId ??= `v${Date.now()}`;
    return this.versionId;
  }

  async begin(
    targetVersionId = this.reserveVersionId(),
    _affectedFileIds: readonly string[] = [],
  ): Promise<void> {
    if (!this.enabled) return;
    if (this.files) {
      if (this.versionId !== targetVersionId) {
        throw new Error("Graph integrity version changed during indexing");
      }
      return;
    }

    let baseline: GraphIntegrityExpectation | undefined;
    let baselineDigest: string | undefined;
    let baselinePruningSupported = false;
    if (this.mode === "incremental") {
      const baselineConn = await getLadybugConn();
      const [latestVersion, state] = await Promise.all([
        ladybugDb.getLatestVersion(baselineConn, this.repoId),
        getDerivedState(this.repoId),
      ]);
      if (
        !latestVersion ||
        !state ||
        !graphIntegrityIsVerifiedForVersion(state, latestVersion.versionId)
      ) {
        throw new Error(INCREMENTAL_BASELINE_ERROR);
      }
      baselineDigest = state.graphIntegrityDigest ?? undefined;
      baselinePruningSupported =
        state.graphIntegrityFilelessPruningSupported === true;
      this.baselineRevision = state.graphIntegrityRevision ?? undefined;
    }

    this.versionId = targetVersionId;
    const activeVerification: ActiveGraphIntegrityVerification = {
      versionId: targetVersionId,
      revision: null,
    };
    this.activeVerification = activeVerification;
    activeVerifications.set(this.repoId, activeVerification);
    try {
      activeVerification.revision = await markGraphIntegrityVerifying(
        this.repoId,
        targetVersionId,
      );
      if (this.mode === "incremental") {
        const baselineConn = await getLadybugConn();
        const fileStates = await listGraphIntegrityFileStates(
          baselineConn,
          this.repoId,
        );
        const filelessStates = await listGraphIntegrityFilelessStates(
          baselineConn,
          this.repoId,
        );
        const actual = await capturePersistedGraphIntegrity(
          baselineConn,
          this.repoId,
        );
        baseline = createGraphIntegrityExpectationFromManifest(
          fileStates,
          filelessStates,
        );
        if (
          baseline.digest !== baselineDigest ||
          compareGraphIntegrityExpectations(baseline, actual)
        ) {
          logger.error("Persisted graph integrity baseline mismatch", {
            repoId: this.repoId,
            targetVersionId,
            expectedDigest: baselineDigest,
            manifestDigest: baseline.digest,
            actualDigest: actual.digest,
            actualSymbolCount: actual.symbolCount,
          });
          throw new GraphIntegrityVerificationError();
        }
        this.filelessSymbols = new Map(
          filelessStates.map((row) => [
            row.symbolId,
            parseGraphIntegrityCanonicalSymbol(row.canonicalSymbolJson),
          ]),
        );
        this.filelessLiveness = new GraphIntegrityFilelessLivenessLedger(true);
        if (!baselinePruningSupported) {
          this.filelessLiveness.disablePruning();
        }
        const seededReferenceCounts = new Map<string, number>();
        for (const file of fileStates) {
          const references = parseGraphIntegrityFilelessReferences(
            file.filelessReferencesJson,
          );
          for (const tuple of references) {
            const reference = graphIntegrityReferenceFromTuple(tuple);
            this.filelessLiveness.seedReferenceCount({
              symbolId: reference.filelessSymbolId,
              edgeType: reference.edgeType,
              referenceCount: reference.referenceCount,
            });
            seededReferenceCounts.set(
              reference.filelessSymbolId,
              (seededReferenceCounts.get(reference.filelessSymbolId) ?? 0) +
                reference.referenceCount,
            );
          }
          this.filelessReferencesByFileId.set(
            file.fileId,
            new Map(references.map((tuple) => {
              const reference = graphIntegrityReferenceFromTuple(tuple);
              return [graphIntegrityEdgeReferenceKey(reference), reference];
            })),
          );
        }
        for (const row of filelessStates) {
          const residual =
            row.referenceCount - (seededReferenceCounts.get(row.symbolId) ?? 0);
          if (residual > 0) {
            this.filelessLiveness.seedReferenceCount({
              symbolId: row.symbolId,
              edgeType: "manifest",
              referenceCount: residual,
            });
          }
        }
      }
      this.files = new Map(
        baseline?.files
          .filter((file) => file.fileId !== FILELESS_SENTINEL)
          .map((file) => [file.relPath, file]) ?? [],
      );
      this.filelessSymbols ??= new Map();
      this.filelessLiveness ??= new GraphIntegrityFilelessLivenessLedger(false);
    } catch (error) {
      await failActiveGraphIntegrityVerification(this.repoId);
      throw error instanceof GraphIntegrityVerificationError
        ? error
        : new GraphIntegrityVerificationError();
    }
  }

  applyFile(file: GraphIntegrityFileDigest): void {
    if (!this.files) return;
    const previous = this.files.get(file.relPath);
    if (previous) this.clearFileReferences(previous.fileId);
    if (file.symbolCount === 0) this.files.delete(file.relPath);
    else this.files.set(file.relPath, file);
  }

  applyProviderRows(rows: ProviderFirstGraphRows): void {
    if (!this.files) return;
    this.removeFilelessSymbols(rows.symbols);
    const symbolsByFileId = new Map<string, typeof rows.symbols>();
    for (const symbol of rows.symbols) {
      this.sourceFileIdBySymbolId.set(symbol.symbolId, symbol.fileId);
      const symbols = symbolsByFileId.get(symbol.fileId);
      if (symbols) symbols.push(symbol);
      else symbolsByFileId.set(symbol.fileId, [symbol]);
    }
    for (const file of rows.files) {
      this.applyFile(
        createGraphIntegrityFileDigest({
          fileId: file.fileId,
          relPath: file.relPath,
          symbols: symbolsByFileId.get(file.fileId) ?? [],
        }),
      );
    }
    this.applyFilelessSymbols(createGraphIntegrityFilelessSymbols(rows));
    this.applyFilelessReferences(
      createGraphIntegrityFilelessEdgeReferences(
        rows.edges,
        this.filelessSymbols?.keys() ?? [],
        { trackSources: true },
      ),
    );
  }

  applyFilelessSymbols(symbols: Iterable<CanonicalSymbol>): void {
    if (!this.filelessSymbols) return;
    for (const symbol of symbols) {
      this.filelessSymbols.set(symbol.symbolId, symbol);
    }
  }

  applyFilelessReferences(
    references: Iterable<GraphIntegrityEdgeReference>,
  ): void {
    if (!this.filelessLiveness) return;
    for (const reference of references) {
      this.filelessLiveness.add(reference);
      const fileId = reference.sourceSymbolId
        ? this.sourceFileIdBySymbolId.get(reference.sourceSymbolId)
        : undefined;
      if (!fileId) continue;
      let byReference = this.filelessReferencesByFileId.get(fileId);
      if (!byReference) {
        byReference = new Map();
        this.filelessReferencesByFileId.set(fileId, byReference);
      }
      const key = graphIntegrityEdgeReferenceKey(reference);
      const previous = byReference.get(key);
      byReference.set(key, {
        ...reference,
        referenceCount:
          (previous?.referenceCount ?? 0) + reference.referenceCount,
      });
    }
  }

  applyPass1Accumulator(accumulator: GraphIntegrityPass1Accumulator): void {
    for (const update of accumulator.symbolMapFileUpdates.values()) {
      this.removeFilelessSymbols(update.symbols);
      for (const symbol of update.symbols) {
        this.sourceFileIdBySymbolId.set(symbol.symbolId, update.fileId);
      }
    }
    for (const file of accumulator.graphIntegrityFiles.values()) {
      this.applyFile(file);
    }
    this.applyFilelessSymbols(
      accumulator.graphIntegrityFilelessSymbols.values(),
    );
    this.applyFilelessReferences(
      accumulator.graphIntegrityFilelessReferences.values(),
    );
    accumulator.graphIntegrityFiles.clear();
    accumulator.graphIntegrityFilelessSymbols.clear();
    accumulator.graphIntegrityFilelessReferences.clear();
  }

  private removeFilelessSymbols(
    symbols: Iterable<Pick<SymbolRow, "symbolId">>,
  ): void {
    if (!this.filelessSymbols) return;
    for (const symbol of symbols) this.filelessSymbols.delete(symbol.symbolId);
  }

  applyPass2EdgeWrite(write: GraphIntegrityEdgeWrite): Promise<void> {
    const task = this.pass2ApplyChain.then(() =>
      this.applyPass2EdgeWriteInternal(write),
    );
    this.pass2ApplyChain = task.catch(() => {});
    return task;
  }

  private async applyPass2EdgeWriteInternal(
    write: GraphIntegrityEdgeWrite,
  ): Promise<void> {
    if (!this.filelessSymbols || !this.filelessLiveness) return;
    if (this.mode === "incremental" && write.symbolIdsToRefresh.length > 0) {
      await this.preparePass2SourceReferences(
        write.symbolIdsToRefresh,
        "call",
      );
      this.removeOutgoingReferences(write.symbolIdsToRefresh, "call");
    }
    for (const symbol of createGraphIntegrityFilelessSymbols({
      symbols: [],
      externalSymbols: [],
      edges: write.edges,
    })) {
      if (!this.filelessSymbols.has(symbol.symbolId)) {
        this.filelessSymbols.set(symbol.symbolId, symbol);
      }
    }
    this.applyFilelessReferences(
      createGraphIntegrityFilelessEdgeReferences(
        write.edges,
        this.filelessSymbols.keys(),
        { trackSources: true },
      ),
    );
  }

  replaceImportTargets(symbolIds: readonly string[]): void {
    this.removeReferencesToTargets(symbolIds, "import");
  }

  removeCallTargets(symbolIds: readonly string[]): void {
    this.removeReferencesToTargets(symbolIds, "call");
  }

  readonly prepareForPlaceholderPruning = async (
    conn: Connection,
  ): Promise<boolean> => {
    if (!this.files || !this.filelessSymbols || !this.filelessLiveness) {
      return false;
    }
    const expectedSymbolCount =
      [...this.files.values()].reduce((count, file) => count + file.symbolCount, 0) +
      this.filelessSymbols.size;
    const otherRepoSymbolCount =
      await getPersistedGraphIntegrityOtherRepoSymbolCount(conn, this.repoId);
    if (
      !graphIntegrityPlaceholderPruningIsSafe(
        expectedSymbolCount,
        otherRepoSymbolCount,
      ) ||
      !this.filelessLiveness.canPrune
    ) {
      return false;
    }
    for (const [symbolId, symbol] of this.filelessSymbols) {
      if (
        isPrunableFilelessSymbol(symbol) &&
        !this.filelessLiveness.isReferenced(symbolId)
      ) {
        this.filelessSymbols.delete(symbolId);
      }
    }
    return true;
  };

  removeFiles(fileIds: readonly string[]): void {
    if (!this.files || fileIds.length === 0) return;
    const removed = new Set(fileIds);
    for (const [relPath, file] of this.files) {
      if (removed.has(file.fileId)) {
        this.clearFileReferences(file.fileId);
        this.files.delete(relPath);
      }
    }
  }

  private removeOutgoingReferences(
    symbolIds: readonly string[],
    edgeType: string,
  ): void {
    const sources = new Set(symbolIds);
    this.removeTrackedReferences(
      (reference) =>
        reference.edgeType === edgeType &&
        reference.sourceSymbolId !== null &&
        sources.has(reference.sourceSymbolId),
    );
  }

  private removeReferencesToTargets(
    symbolIds: readonly string[],
    edgeType: string,
  ): void {
    const targets = new Set(symbolIds);
    this.removeTrackedReferences(
      (reference) =>
        reference.edgeType === edgeType &&
        targets.has(reference.filelessSymbolId),
    );
  }

  private clearFileReferences(fileId: string): void {
    const references = this.filelessReferencesByFileId.get(fileId);
    if (!references) return;
    for (const reference of references.values()) {
      this.filelessLiveness?.remove(reference);
    }
    this.filelessReferencesByFileId.delete(fileId);
  }

  private removeTrackedReferences(
    predicate: (reference: GraphIntegrityEdgeReference) => boolean,
  ): void {
    for (const [fileId, references] of this.filelessReferencesByFileId) {
      for (const [key, reference] of references) {
        if (!predicate(reference)) continue;
        this.filelessLiveness?.remove(reference);
        references.delete(key);
      }
      if (references.size === 0) {
        this.filelessReferencesByFileId.delete(fileId);
      }
    }
  }

  async complete(versionId: string): Promise<void> {
    if (!this.files) return;
    if (this.versionId !== versionId) {
      throw new Error("Graph integrity version changed during indexing");
    }
    try {
      const stagedRevision = await this.stageManifest(versionId);
      if (stagedRevision === undefined) {
        throw new GraphIntegrityVerificationError();
      }
      await completeGraphIntegrityVerification(
        this.repoId,
        versionId,
        this.createExpectedGraph(),
        { expectedRevision: stagedRevision },
      );
    } finally {
      if (activeVerifications.get(this.repoId) === this.activeVerification) {
        activeVerifications.delete(this.repoId);
      }
      this.files = undefined;
      this.filelessSymbols = undefined;
      this.filelessLiveness = undefined;
      this.sourceFileIdBySymbolId.clear();
      this.filelessReferencesByFileId.clear();
      this.stagedRevision = undefined;
      this.baselineRevision = undefined;
      this.activeVerification = undefined;
      this.pass2ApplyChain = Promise.resolve();
    }
  }

  async stageManifest(versionId: string): Promise<number | undefined> {
    if (!this.files || this.stagedRevision !== undefined) {
      return this.stagedRevision;
    }
    if (this.versionId !== versionId) {
      throw new Error("Graph integrity version changed during indexing");
    }
    await this.pass2ApplyChain;
    const manifest = this.createManifest();
    const active = activeVerifications.get(this.repoId);
    if (
      !active ||
      active !== this.activeVerification ||
      active.versionId !== versionId
    ) {
      throw new GraphIntegrityVerificationError();
    }
    const revision = await withWriteConn((conn) =>
      ladybugDb.withTransaction(conn, async (txConn) => {
        let nextRevision: number | null;
        if (active.revision === null) {
          const initialRevision =
            this.mode === "full" ? 0 : (this.baselineRevision ?? -1) + 1;
          nextRevision = await initializeGraphIntegrityVersionInTransaction(
            txConn,
            this.repoId,
            versionId,
            this.filelessLiveness?.canPrune ?? false,
            initialRevision,
            this.mode === "full" ? null : this.baselineRevision ?? null,
          );
        } else {
          nextRevision = await advanceGraphIntegrityRevisionInTransaction(
            txConn,
            this.repoId,
            versionId,
            active.revision,
          );
        }
        if (nextRevision === null) {
          throw new GraphIntegrityVerificationError();
        }
        await replaceGraphIntegrityManifestInTransaction(
          txConn,
          this.repoId,
          manifest,
        );
        return nextRevision;
      }),
    );
    this.stagedRevision = revision;
    active.revision = revision;
    return revision;
  }

  ownsStagedRevision(
    versionId: string,
    state: Awaited<ReturnType<typeof getDerivedState>>,
  ): boolean {
    return Boolean(
      this.stagedRevision !== undefined &&
        state?.graphIntegrityState === "verifying" &&
        state.graphIntegrityVersionId === versionId &&
        state.graphIntegrityRevision === this.stagedRevision,
    );
  }

  private createExpectedGraph(): GraphIntegrityExpectation {
    const expectedFiles = [...(this.files?.values() ?? [])];
    if (this.filelessSymbols && this.filelessSymbols.size > 0) {
      expectedFiles.push(
        createGraphIntegrityFileDigest({
          fileId: FILELESS_SENTINEL,
          relPath: FILELESS_SENTINEL,
          symbols: [...this.filelessSymbols.values()],
        }),
      );
    }
    return createGraphIntegrityExpectation(expectedFiles);
  }

  private createManifest(): {
    files: GraphIntegrityFileStateRecord[];
    fileless: GraphIntegrityFilelessStateRecord[];
  } {
    const filelessSymbols = this.filelessSymbols ?? new Map();
    const files = [...(this.files?.values() ?? [])].map((file) => {
      const references = [...(
        this.filelessReferencesByFileId.get(file.fileId)?.values() ?? []
      )]
        .map((reference) => {
          const symbol = filelessSymbols.get(reference.filelessSymbolId);
          return symbol
            ? graphIntegrityReferenceToTuple(reference, symbol)
            : null;
        })
        .filter(
          (tuple): tuple is GraphIntegrityFilelessReferenceTuple =>
            tuple !== null,
        )
        .sort((left, right) =>
          compareText(JSON.stringify(left), JSON.stringify(right)),
        );
      return {
        stateId: JSON.stringify([this.repoId, file.fileId]),
        repoId: this.repoId,
        fileId: file.fileId,
        relPath: file.relPath,
        symbolCount: file.symbolCount,
        digest: file.digest,
        filelessReferencesJson: JSON.stringify(references),
      };
    });
    const referenceCounts = new Map(this.filelessLiveness?.entries() ?? []);
    const fileless = [...filelessSymbols.values()]
      .sort((left, right) => compareText(left.symbolId, right.symbolId))
      .map((symbol) => ({
        stateId: JSON.stringify([this.repoId, symbol.symbolId]),
        repoId: this.repoId,
        symbolId: symbol.symbolId,
        canonicalSymbolJson: serializeGraphIntegrityCanonicalSymbol(symbol),
        referenceCount: referenceCounts.get(symbol.symbolId) ?? 0,
      }));
    return { files, fileless };
  }

  private async preparePass2SourceReferences(
    sourceSymbolIds: readonly string[],
    edgeType: string,
  ): Promise<void> {
    if (!this.filelessLiveness?.canPrune) return;
    const unprepared = [...new Set(sourceSymbolIds)].filter(
      (symbolId) =>
        !this.filelessLiveness!.currentSourceIsPrepared(symbolId, edgeType),
    );
    if (unprepared.length === 0) return;
    const conn = await getLadybugConn();
    for (let offset = 0; offset < unprepared.length; offset += GRAPH_INTEGRITY_FILE_ID_CHUNK_SIZE) {
      const chunk = unprepared.slice(
        offset,
        offset + GRAPH_INTEGRITY_FILE_ID_CHUNK_SIZE,
      );
      const rows = await getPersistedGraphIntegritySourceReferenceCounts(
        conn,
        this.repoId,
        chunk,
        edgeType,
      );
      const ambiguousSources = new Set<string>();
      for (const row of rows) {
        const knownFileId = this.sourceFileIdBySymbolId.get(row.sourceSymbolId);
        if (knownFileId && knownFileId !== row.fileId) {
          ambiguousSources.add(row.sourceSymbolId);
        } else {
          this.sourceFileIdBySymbolId.set(row.sourceSymbolId, row.fileId);
        }
        if (row.symbolId !== null && row.referenceCount > 0) {
          this.filelessLiveness.seedCurrentSourceReference(
            row.sourceSymbolId,
            { ...row, symbolId: row.symbolId },
          );
        }
      }
      for (const symbolId of chunk) {
        if (
          ambiguousSources.has(symbolId) ||
          !this.sourceFileIdBySymbolId.has(symbolId)
        ) {
          // Without exact file ownership, retaining placeholders is safer than
          // persisting an aggregate reference that a later file refresh cannot remove.
          this.filelessLiveness.disablePruning();
          continue;
        }
        this.filelessLiveness.markCurrentSourcePrepared(symbolId, edgeType);
      }
    }
  }
}

/**
 * Verify an unchanged incremental graph against the latest published digest.
 * This is intentionally read-only on success so a clean no-op reuses the
 * existing version instead of manufacturing a new snapshot.
 */
export async function verifyNoOpIncrementalGraphIntegrity(
  repoId: string,
  options: Pick<GraphIntegrityVerificationOptions, "afterCapture"> = {},
): Promise<string> {
  const conn = await getLadybugConn();
  const [latestVersion, state] = await Promise.all([
    ladybugDb.getLatestVersion(conn, repoId),
    getDerivedState(repoId),
  ]);
  if (
    !latestVersion ||
    !state ||
    !graphIntegrityIsVerifiedForVersion(state, latestVersion.versionId) ||
    typeof state.graphIntegrityRevision !== "number"
  ) {
    throw new Error(INCREMENTAL_BASELINE_ERROR);
  }
  const expectedRevision = state.graphIntegrityRevision;

  const actual = await capturePersistedGraphIntegrity(conn, repoId);
  await options.afterCapture?.();
  if (actual.digest !== state.graphIntegrityDigest) {
    logger.error("Persisted graph integrity no-op mismatch", {
      repoId,
      versionId: latestVersion.versionId,
      expectedDigest: state.graphIntegrityDigest,
      actualDigest: actual.digest,
      actualSymbolCount: actual.symbolCount,
    });
    await markCurrentGraphIntegrityRevisionFailed(
      repoId,
      latestVersion.versionId,
      expectedRevision,
      GRAPH_INTEGRITY_VERIFICATION_FAILURE,
    );
    throw new GraphIntegrityVerificationError();
  }

  const stateAfterCapture = await getDerivedState(repoId);
  if (
    !stateAfterCapture ||
    !graphIntegrityIsVerifiedForVersion(
      stateAfterCapture,
      latestVersion.versionId,
    ) ||
    stateAfterCapture.graphIntegrityDigest !== actual.digest
  ) {
    throw new Error(INCREMENTAL_BASELINE_ERROR);
  }
  return latestVersion.versionId;
}

export function hasActiveGraphIntegrityVerification(repoId: string): boolean {
  return activeVerifications.has(repoId);
}

export async function ensureGraphIntegrityVerificationComplete(
  repoId: string,
): Promise<void> {
  if (!hasActiveGraphIntegrityVerification(repoId)) return;
  await failActiveGraphIntegrityVerification(repoId);
  throw new GraphIntegrityVerificationError();
}

export async function failActiveGraphIntegrityVerification(
  repoId: string,
): Promise<void> {
  const verification = activeVerifications.get(repoId);
  if (!verification) return;
  activeVerifications.delete(repoId);
  const { versionId, revision } = verification;
  try {
    if (revision === null) {
      await markUnrevisionedGraphIntegrityFailedIfVerifying(
        repoId,
        versionId,
        "Persisted graph integrity verification did not complete",
      );
    } else {
      await failGraphIntegrityVerification(repoId, versionId, revision);
    }
  } catch (error) {
    logger.error("Failed to persist graph integrity failure state", {
      repoId,
      versionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Reduce authoritative in-memory Symbol rows to a deterministic per-file
 * digest. Raw providerId is intentionally absent: provider symbol identity
 * already commits it into symbolId, while source records the provider type.
 * summarySource is also absent because post-write semantic refresh can
 * legitimately replace it before the required final persisted-graph read.
 */
export function createGraphIntegrityFileDigest(params: {
  fileId: string;
  relPath: string;
  symbols: readonly CanonicalSymbol[];
}): GraphIntegrityFileDigest {
  const builder = createMutableFileDigest(
    params.fileId,
    normalizeGraphIntegrityPath(params.relPath),
  );
  const symbols = [...params.symbols].sort((left, right) =>
    compareText(left.symbolId, right.symbolId),
  );
  let previousSymbolId: string | undefined;
  for (const symbol of symbols) {
    if (symbol.fileId !== params.fileId) {
      throw new Error(
        `Graph integrity symbol ${symbol.symbolId} belongs to ${symbol.fileId}, expected ${params.fileId}`,
      );
    }
    if (symbol.symbolId === previousSymbolId) continue;
    appendCanonicalSymbol(builder, symbol);
    previousSymbolId = symbol.symbolId;
  }
  return finishMutableFileDigest(builder);
}

export function createGraphIntegrityFileState(
  repoId: string,
  fileId: string,
  relPath: string,
  symbols: readonly GraphIntegrityCanonicalSymbol[],
  filelessReferences: readonly GraphIntegrityFilelessReferenceTuple[],
): GraphIntegrityFileStateRecord {
  const file = createGraphIntegrityFileDigest({ fileId, relPath, symbols });
  const references = filelessReferences
    .map(normalizeGraphIntegrityFilelessReference)
    .sort((left, right) =>
      compareText(JSON.stringify(left), JSON.stringify(right)),
    );
  return {
    stateId: JSON.stringify([repoId, fileId]),
    repoId,
    fileId,
    relPath: file.relPath,
    symbolCount: file.symbolCount,
    digest: file.digest,
    filelessReferencesJson: JSON.stringify(references),
  };
}

export function graphIntegrityFileStateMatchesDigest(
  state: GraphIntegrityFileStateRecord,
  file: GraphIntegrityFileDigest,
): boolean {
  return (
    state.fileId === file.fileId &&
    normalizeGraphIntegrityPath(state.relPath) === file.relPath &&
    state.symbolCount === file.symbolCount &&
    state.digest === file.digest
  );
}

export function parseGraphIntegrityCanonicalSymbol(
  json: string,
): GraphIntegrityCanonicalSymbol {
  const fields = parseGraphIntegrityArray(json, "canonical symbol");
  if (
    fields.length !== 18 ||
    !fields.slice(0, 7).every((value) => typeof value === "string") ||
    !fields.slice(7, 11).every(isSafeInteger) ||
    !fields.slice(11, 15).every((value) => typeof value === "string") ||
    typeof fields[15] !== "boolean" ||
    typeof fields[16] !== "string" ||
    typeof fields[17] !== "string" ||
    fields[1] !== FILELESS_SENTINEL ||
    fields[2] !== FILELESS_SENTINEL ||
    !isGraphIntegritySymbolStatus(fields[14])
  ) {
    throw new Error("Malformed graph integrity canonical symbol JSON");
  }

  const canonical = fields as unknown as GraphIntegrityCanonicalSymbolTuple;
  return {
    symbolId: canonical[0],
    fileId: canonical[1],
    name: canonical[3],
    signatureJson: canonical[4],
    kind: canonical[5],
    language: canonical[6],
    rangeStartLine: canonical[7],
    rangeStartCol: canonical[8],
    rangeEndLine: canonical[9],
    rangeEndCol: canonical[10],
    source: canonical[11],
    scipSymbol: canonical[12],
    astFingerprint: canonical[13],
    symbolStatus: canonical[14],
    external: canonical[15],
    placeholderKind: canonical[16],
    placeholderTarget: canonical[17],
  };
}

export function parseGraphIntegrityFilelessReferences(
  json: string,
): GraphIntegrityFilelessReferenceTuple[] {
  return parseGraphIntegrityArray(json, "fileless references").map(
    (value): GraphIntegrityFilelessReferenceTuple => {
      if (
        !Array.isArray(value) ||
        value.length !== 6 ||
        typeof value[0] !== "string" ||
        typeof value[1] !== "string" ||
        (value[2] !== null && typeof value[2] !== "string") ||
        typeof value[3] !== "string" ||
        (value[4] !== "incoming" && value[4] !== "outgoing") ||
        !Number.isSafeInteger(value[5]) ||
        (value[5] as number) < 0
      ) {
        throw new Error("Malformed graph integrity fileless reference JSON");
      }
      const canonical = parseGraphIntegrityCanonicalSymbol(value[1]);
      if (canonical.symbolId !== value[0]) {
        throw new Error("Graph integrity fileless reference identity mismatch");
      }
      return [value[0], value[1], value[2], value[3], value[4], value[5] as number];
    },
  );
}

export function createGraphIntegrityFilelessDelta(
  repoId: string,
  current: ReadonlyMap<string, GraphIntegrityFilelessStateRecord>,
  previous: readonly GraphIntegrityFilelessReferenceTuple[],
  next: readonly GraphIntegrityFilelessReferenceTuple[],
  pruningSupported: boolean,
): GraphIntegrityFilelessDelta {
  const previousBySymbol = aggregateGraphIntegrityFilelessReferences(previous);
  const nextBySymbol = aggregateGraphIntegrityFilelessReferences(next);
  const touched = [...new Set([...previousBySymbol.keys(), ...nextBySymbol.keys()])]
    .sort(compareText);
  const upserts: GraphIntegrityFilelessStateRecord[] = [];
  const deleteSymbolIds: string[] = [];

  for (const symbolId of touched) {
    const existing = current.get(symbolId);
    if (
      existing &&
      (existing.repoId !== repoId ||
        existing.stateId !== JSON.stringify([repoId, symbolId]))
    ) {
      throw new Error("Graph integrity fileless state identity mismatch");
    }
    const existingCanonicalSymbolJson = existing
      ? normalizeGraphIntegrityCanonicalSymbolJson(
          symbolId,
          existing.canonicalSymbolJson,
        )
      : undefined;
    const currentReferenceCount = existing?.referenceCount ?? 0;
    const previousReferenceCount =
      previousBySymbol.get(symbolId)?.referenceCount ?? 0;
    if (currentReferenceCount < previousReferenceCount) {
      throw new DatabaseError(
        "Graph integrity fileless baseline reference count is inconsistent",
      );
    }
    const referenceCount =
      currentReferenceCount -
      previousReferenceCount +
      (nextBySymbol.get(symbolId)?.referenceCount ?? 0);
    if (!Number.isSafeInteger(referenceCount) || referenceCount < 0) {
      throw new Error("Graph integrity fileless reference count is invalid");
    }
    if (referenceCount === 0 && pruningSupported) {
      if (existing) deleteSymbolIds.push(symbolId);
      continue;
    }
    const canonicalSymbolJson =
      nextBySymbol.get(symbolId)?.canonicalSymbolJson ??
      existingCanonicalSymbolJson ??
      previousBySymbol.get(symbolId)?.canonicalSymbolJson;
    if (!canonicalSymbolJson) {
      throw new Error("Graph integrity fileless canonical symbol is missing");
    }
    upserts.push({
      stateId: JSON.stringify([repoId, symbolId]),
      repoId,
      symbolId,
      canonicalSymbolJson,
      referenceCount,
    });
  }
  return { upserts, deleteSymbolIds };
}

export function createGraphIntegrityFilelessReferenceTuples(
  references: readonly GraphIntegrityEdgeReference[],
  symbols: readonly GraphIntegrityCanonicalSymbol[],
  current: ReadonlyMap<string, GraphIntegrityFilelessStateRecord>,
): GraphIntegrityFilelessReferenceTuple[] {
  const symbolById = new Map(symbols.map((symbol) => [symbol.symbolId, symbol]));
  return references
    .map((reference): GraphIntegrityFilelessReferenceTuple => {
      const existing = current.get(reference.filelessSymbolId);
      const symbol = symbolById.get(reference.filelessSymbolId);
      if (!existing && !symbol) {
        throw new Error("Graph integrity fileless canonical symbol is missing");
      }
      const canonicalSymbolJson = existing
        ? normalizeGraphIntegrityCanonicalSymbolJson(
            reference.filelessSymbolId,
            existing.canonicalSymbolJson,
          )
        : serializeGraphIntegrityCanonicalSymbol(symbol!);
      return [
        reference.filelessSymbolId,
        canonicalSymbolJson,
        reference.sourceSymbolId,
        reference.edgeType,
        reference.direction,
        reference.referenceCount,
      ];
    })
    .sort((left, right) => compareText(JSON.stringify(left), JSON.stringify(right)));
}

export function createGraphIntegrityExpectationFromManifest(
  files: readonly GraphIntegrityFileStateRecord[],
  fileless: readonly GraphIntegrityFilelessStateRecord[],
): GraphIntegrityExpectation {
  const digests: GraphIntegrityFileDigest[] = files.map((file) => ({
    fileId: file.fileId,
    relPath: normalizeGraphIntegrityPath(file.relPath),
    symbolCount: file.symbolCount,
    digest: file.digest,
    pages: [],
  }));
  if (fileless.length > 0) {
    const symbols = fileless.map((row) => {
      if (row.stateId !== JSON.stringify([row.repoId, row.symbolId])) {
        throw new Error("Graph integrity fileless state identity mismatch");
      }
      const symbol = parseGraphIntegrityCanonicalSymbol(row.canonicalSymbolJson);
      if (symbol.symbolId !== row.symbolId) {
        throw new Error("Graph integrity fileless state identity mismatch");
      }
      return symbol;
    });
    digests.push(
      createGraphIntegrityFileDigest({
        fileId: FILELESS_SENTINEL,
        relPath: FILELESS_SENTINEL,
        symbols,
      }),
    );
  }
  return createGraphIntegrityExpectation(digests);
}

/**
 * Build canonical fileless Symbol rows from provider externals and non-real
 * dependency targets before persistence. Real cross-file targets are omitted:
 * their authoritative file-backed rows are already included per file.
 */
export function createGraphIntegrityFilelessSymbols(rows: {
  symbols: readonly Pick<SymbolRow, "symbolId">[];
  externalSymbols: readonly ProviderFirstExternalSymbolRow[];
  edges: readonly EdgeRow[];
  canonicalizeDependencyPlaceholders?: boolean;
}): CanonicalSymbol[] {
  const fileBackedIds = new Set(rows.symbols.map((symbol) => symbol.symbolId));
  const fileless = new Map<string, CanonicalSymbol>();
  for (const symbol of rows.externalSymbols) {
    if (fileBackedIds.has(symbol.symbolId)) continue;
    fileless.set(symbol.symbolId, {
      symbolId: symbol.symbolId,
      fileId: FILELESS_SENTINEL,
      name: symbol.name,
      kind: symbol.kind,
      language: symbol.language ?? "external",
      rangeStartLine: symbol.rangeStartLine ?? 0,
      rangeStartCol: symbol.rangeStartCol ?? 0,
      rangeEndLine: symbol.rangeEndLine ?? 0,
      rangeEndCol: symbol.rangeEndCol ?? 0,
      signatureJson: null,
      source: symbol.source,
      scipSymbol: symbol.scipSymbol,
      astFingerprint: symbol.symbolId,
      symbolStatus: symbol.external ? "external" : "real",
      external: symbol.external,
      placeholderKind: symbol.external ? "scip" : "",
      placeholderTarget: symbol.external ? symbol.scipSymbol : "",
    });
  }
  for (const edge of rows.edges) {
    if (
      fileBackedIds.has(edge.toSymbolId) ||
      fileless.has(edge.toSymbolId)
    ) {
      continue;
    }
    // Finalization canonicalizes unresolved placeholders from their encoded ID,
    // so stale resolver hints must not make the pre-write expectation diverge.
    const metadata = edge.toSymbolId.startsWith("unresolved:")
      ? classifyDependencyTarget(edge.toSymbolId)
      : edge.targetMeta ?? classifyDependencyTarget(edge.toSymbolId);
    if (metadata.symbolStatus === "real") continue;
    const canonical = rows.canonicalizeDependencyPlaceholders ?? true;
    fileless.set(edge.toSymbolId, {
      symbolId: edge.toSymbolId,
      fileId: FILELESS_SENTINEL,
      name: canonical ? edge.toSymbolId : "",
      kind: canonical ? "unknown" : "",
      language: canonical ? "unknown" : "",
      rangeStartLine: 0,
      rangeStartCol: 0,
      rangeEndLine: 0,
      rangeEndCol: 0,
      signatureJson: null,
      source: "treesitter",
      scipSymbol: null,
      astFingerprint: canonical ? edge.toSymbolId : "",
      symbolStatus: metadata.symbolStatus,
      external: metadata.symbolStatus === "external",
      placeholderKind: metadata.placeholderKind ?? "",
      placeholderTarget: metadata.placeholderTarget ?? "",
    });
  }
  return [...fileless.values()].sort((left, right) =>
    compareText(left.symbolId, right.symbolId),
  );
}

export function createGraphIntegrityFilelessEdgeReferences(
  edges: readonly Pick<EdgeRow, "fromSymbolId" | "toSymbolId" | "edgeType">[],
  filelessSymbolIds: Iterable<string>,
  options: { trackSources: boolean },
): GraphIntegrityEdgeReference[] {
  const fileless = new Set(filelessSymbolIds);
  const references = new Map<string, GraphIntegrityEdgeReference>();
  for (const edge of edges) {
    if (fileless.has(edge.fromSymbolId)) {
      addGraphIntegrityEdgeReference(references, {
        filelessSymbolId: edge.fromSymbolId,
        sourceSymbolId: null,
        edgeType: edge.edgeType,
        direction: "outgoing",
        referenceCount: 1,
      });
    }
    if (fileless.has(edge.toSymbolId)) {
      addGraphIntegrityEdgeReference(references, {
        filelessSymbolId: edge.toSymbolId,
        sourceSymbolId: options.trackSources ? edge.fromSymbolId : null,
        edgeType: edge.edgeType,
        direction: "incoming",
        referenceCount: 1,
      });
    }
  }
  return [...references.values()];
}

export function graphIntegrityPlaceholderPruningIsSafe(
  expectedRepoSymbolCount: number,
  otherRepoSymbolCount: number,
): boolean {
  return expectedRepoSymbolCount + otherRepoSymbolCount <=
    ladybugDb.LADYBUG_SAFE_SYMBOL_DELETE_ROW_LIMIT;
}

function graphIntegrityEdgeReferenceKey(
  reference: GraphIntegrityEdgeReference,
): string {
  return JSON.stringify([
    reference.filelessSymbolId,
    reference.sourceSymbolId,
    reference.edgeType,
    reference.direction,
  ]);
}

function addGraphIntegrityEdgeReference(
  references: Map<string, GraphIntegrityEdgeReference>,
  reference: GraphIntegrityEdgeReference,
): void {
  const key = graphIntegrityEdgeReferenceKey(reference);
  const previous = references.get(key);
  references.set(key, {
    ...reference,
    referenceCount:
      (previous?.referenceCount ?? 0) + reference.referenceCount,
  });
}

function referenceCountKey(symbolId: string, edgeType: string): string {
  return JSON.stringify([symbolId, edgeType]);
}

function currentSourceTypeKey(symbolId: string, edgeType: string): string {
  return JSON.stringify([symbolId, edgeType]);
}

function addNestedReferenceCount(
  index: Map<string, Map<string, Map<string, number>>>,
  first: string,
  second: string,
  third: string,
  count: number,
): void {
  let bySecond = index.get(first);
  if (!bySecond) {
    bySecond = new Map();
    index.set(first, bySecond);
  }
  let byThird = bySecond.get(second);
  if (!byThird) {
    byThird = new Map();
    bySecond.set(second, byThird);
  }
  byThird.set(third, (byThird.get(third) ?? 0) + count);
}

function removeNestedReferenceCount(
  index: Map<string, Map<string, Map<string, number>>>,
  first: string,
  second: string,
  third: string,
): void {
  const bySecond = index.get(first);
  const byThird = bySecond?.get(second);
  if (!byThird) return;
  byThird.delete(third);
  if (byThird.size === 0) bySecond!.delete(second);
  if (bySecond!.size === 0) index.delete(first);
}

function isPrunableFilelessSymbol(symbol: CanonicalSymbol): boolean {
  return (
    symbol.symbolId.startsWith("unresolved:") ||
    symbol.symbolStatus === "unresolved" ||
    symbol.symbolStatus === "external"
  );
}

export function createGraphIntegrityExpectation(
  fileDigests: Iterable<GraphIntegrityFileDigest>,
): GraphIntegrityExpectation {
  const files = [...fileDigests]
    .filter((file) => file.symbolCount > 0)
    .sort(compareFiles);
  const digest = createHash("sha256");
  let symbolCount = 0;
  let previousKey: string | undefined;
  for (const file of files) {
    const key = `${file.relPath}\0${file.fileId}`;
    if (key === previousKey) {
      throw new Error(`Graph integrity input contains duplicate file ${key}`);
    }
    symbolCount += file.symbolCount;
    digest.update(
      `${JSON.stringify([
        file.relPath,
        file.fileId,
        file.symbolCount,
        file.digest,
      ])}\n`,
    );
    previousKey = key;
  }
  return {
    symbolCount,
    digest: digest.update(`count:${symbolCount}\n`).digest("hex"),
    files,
  };
}

/** Page the final active DB in canonical file/symbol order. */
export async function capturePersistedGraphIntegrity(
  conn: Connection,
  repoId: string,
  options: { checkCancelled?: () => void } = {},
): Promise<GraphIntegrityExpectation> {
  return capturePersistedGraphIntegrityInternal(
    conn,
    repoId,
    undefined,
    options.checkCancelled,
  );
}

function graphIntegrityReferenceFromTuple(
  tuple: GraphIntegrityFilelessReferenceTuple,
): GraphIntegrityEdgeReference {
  return {
    filelessSymbolId: tuple[0],
    sourceSymbolId: tuple[2],
    edgeType: tuple[3],
    direction: tuple[4],
    referenceCount: tuple[5],
  };
}

function graphIntegrityReferenceToTuple(
  reference: GraphIntegrityEdgeReference,
  symbol: CanonicalSymbol,
): GraphIntegrityFilelessReferenceTuple {
  return [
    reference.filelessSymbolId,
    serializeGraphIntegrityCanonicalSymbol(symbol),
    reference.sourceSymbolId,
    reference.edgeType,
    reference.direction,
    reference.referenceCount,
  ];
}

async function capturePersistedGraphIntegrityInternal(
  conn: Connection,
  repoId: string,
  onSymbol?: (symbol: CanonicalSymbol) => void,
  checkCancelled?: () => void,
): Promise<GraphIntegrityExpectation> {
  const files: GraphIntegrityFileDigest[] = [];
  let current: MutableFileDigest | undefined;
  let cursor: GraphIntegritySymbolCursor | undefined;

  while (true) {
    // Cancellation is cooperative: never interrupt a native Ladybug query.
    checkCancelled?.();
    const rows = await getPersistedGraphIntegritySymbolPage(
      conn,
      {
        repoId,
        after: cursor,
        limit: GRAPH_INTEGRITY_QUERY_PAGE_SIZE,
      },
    );
    if (rows.length === 0) break;

    for (const row of rows) {
      if (
        current &&
        (current.fileId !== row.fileId || current.relPath !== row.relPath)
      ) {
        files.push(finishMutableFileDigest(current));
        current = undefined;
      }
      current ??= createMutableFileDigest(row.fileId, row.relPath);
      const canonicalSymbol = canonicalizePersistedGraphIntegritySymbol({
        symbolId: row.symbolId,
        fileId: row.fileId,
        name: row.name,
        kind: row.kind,
        language: row.language,
        rangeStartLine: row.rangeStartLine,
        rangeStartCol: row.rangeStartCol,
        rangeEndLine: row.rangeEndLine,
        rangeEndCol: row.rangeEndCol,
        signatureJson: row.signatureJson,
        source: row.source,
        scipSymbol: row.scipSymbol,
        astFingerprint: row.astFingerprint ?? "",
        symbolStatus: row.symbolStatus ?? undefined,
        external: row.external,
        placeholderKind: row.placeholderKind,
        placeholderTarget: row.placeholderTarget,
      });
      appendCanonicalSymbol(current, canonicalSymbol);
      onSymbol?.(canonicalSymbol);
    }
    const last = rows.at(-1)!;
    cursor = {
      relPath: last.relPath,
      fileId: last.fileId,
      symbolId: last.symbolId,
    };
  }
  if (current) files.push(finishMutableFileDigest(current));
  return createGraphIntegrityExpectation(files);
}

/** @internal Background-only snapshot scan and revision-CAS publication. */
export async function verifyPersistedGraphIntegrityRevision(
  repoId: string,
  versionId: string,
  revision: number,
  options: {
    checkCancelled?: () => void;
    /** @internal Minimal test hook proving the read lease closes before CAS. */
    persistSuccessState?: typeof markGraphIntegrityVerifiedIfVerifying;
  } = {},
): Promise<"verified" | "failed" | "stale"> {
  const snapshot = await withExclusiveReadConnection((conn) =>
    withReadOnlyTransaction(conn, async () => {
      options.checkCancelled?.();
      const files = await listGraphIntegrityFileStates(conn, repoId);
      options.checkCancelled?.();
      const fileless = await listGraphIntegrityFilelessStates(conn, repoId);
      options.checkCancelled?.();
      let expected: GraphIntegrityExpectation;
      try {
        expected = createGraphIntegrityExpectationFromManifest(files, fileless);
      } catch (error) {
        if (error instanceof GraphIntegrityManifestValidationError) throw error;
        throw new GraphIntegrityManifestValidationError(
          error instanceof Error
            ? error.message
            : "Graph integrity manifest is invalid",
        );
      }
      const actual = await capturePersistedGraphIntegrity(conn, repoId, {
        checkCancelled: options.checkCancelled,
      });
      return { actual, mismatch: compareGraphIntegrityExpectations(expected, actual) };
    }),
  );
  options.checkCancelled?.();

  // The read transaction and exclusive lease must end before acquiring the
  // single writer for the tiny publication CAS.
  if (snapshot.mismatch) {
    logger.error("Persisted graph integrity background mismatch", {
      repoId,
      versionId,
      revision,
      mismatch: snapshot.mismatch,
    });
    const published = await markGraphIntegrityFailedIfVerifying(
      repoId,
      versionId,
      revision,
      GRAPH_INTEGRITY_VERIFICATION_FAILURE,
    );
    return published ? "failed" : "stale";
  }

  const published = await (
    options.persistSuccessState ?? markGraphIntegrityVerifiedIfVerifying
  )(repoId, versionId, revision, snapshot.actual.digest);
  return published ? "verified" : "stale";
}

/**
 * Historical provider externals can predate the canonical derived fingerprint
 * and empty signature written by current active and shadow writers. Normalize
 * only those two definition-derived fields while hashing every classification
 * and placeholder field exactly as persisted. Dependency placeholders are
 * physically normalized during finalization instead of being hidden here.
 */
function canonicalizePersistedGraphIntegritySymbol(
  symbol: CanonicalSymbol,
): CanonicalSymbol {
  if (
    symbol.fileId !== FILELESS_SENTINEL ||
    symbol.scipSymbol === null
  ) {
    return symbol;
  }
  return {
    ...symbol,
    signatureJson: null,
    astFingerprint: symbol.symbolId,
  };
}

export function compareGraphIntegrityExpectations(
  expected: GraphIntegrityExpectation,
  actual: GraphIntegrityExpectation,
): GraphIntegrityMismatchDiagnostic | null {
  if (
    expected.symbolCount === actual.symbolCount &&
    expected.digest === actual.digest
  ) {
    return null;
  }

  const fileIndex = firstDifferentIndex(
    expected.files,
    actual.files,
    fileDigestsEqual,
  );
  const expectedFile = expected.files[fileIndex];
  const actualFile = actual.files[fileIndex];
  const diagnostic: GraphIntegrityMismatchDiagnostic = {
    expectedCount: expected.symbolCount,
    actualCount: actual.symbolCount,
    expectedDigest: expected.digest,
    actualDigest: actual.digest,
    fileIndex,
    expectedFile: boundedFile(expectedFile),
    actualFile: boundedFile(actualFile),
  };
  if (
    expectedFile &&
    actualFile &&
    expectedFile.fileId === actualFile.fileId &&
    expectedFile.relPath === actualFile.relPath
  ) {
    const pageIndex = firstDifferentIndex(
      expectedFile.pages,
      actualFile.pages,
      pageDigestsEqual,
    );
    diagnostic.pageIndex = pageIndex;
    diagnostic.expectedPage = boundedPage(expectedFile.pages[pageIndex]);
    diagnostic.actualPage = boundedPage(actualFile.pages[pageIndex]);
  }
  return diagnostic;
}

export async function completeGraphIntegrityVerification(
  repoId: string,
  versionId: string,
  expected: GraphIntegrityExpectation,
  options: GraphIntegrityVerificationOptions = {},
): Promise<void> {
  const startedAt = Date.now();
  let verificationRevision: number | null = options.expectedRevision ?? null;
  try {
    const verificationState = await getDerivedState(repoId);
    if (
      !verificationState ||
      verificationState.graphIntegrityState !== "verifying" ||
      verificationState.graphIntegrityVersionId !== versionId ||
      (options.expectedRevision !== undefined &&
        verificationState.graphIntegrityRevision !== options.expectedRevision)
    ) {
      throw new GraphIntegrityVerificationError();
    }
    verificationRevision ??= verificationState.graphIntegrityRevision ?? null;

    const actual = await capturePersistedGraphIntegrity(
      await getLadybugConn(),
      repoId,
    );
    await options.afterCapture?.();
    const mismatch = compareGraphIntegrityExpectations(expected, actual);
    if (mismatch) {
      logger.error("Persisted graph integrity mismatch", {
        repoId,
        versionId,
        mismatch,
      });
      throw new GraphIntegrityVerificationError();
    }
    if (verificationRevision === null) {
      verificationRevision =
        await initializeGraphIntegrityRevisionIfVerifying(repoId, versionId);
    }
    if (verificationRevision === null) {
      logger.error("Persisted graph integrity publish lost verification state", {
        repoId,
        versionId,
      });
      throw new GraphIntegrityVerificationError();
    }
    const published = await markGraphIntegrityVerifiedIfVerifying(
      repoId,
      versionId,
      verificationRevision,
      actual.digest,
    );
    if (!published) {
      logger.error("Persisted graph integrity publish lost verification state", {
        repoId,
        versionId,
      });
      throw new GraphIntegrityVerificationError();
    }
    logger.info("Persisted graph integrity verified", {
      repoId,
      versionId,
      symbolCount: actual.symbolCount,
      durationMs: Date.now() - startedAt,
    });
  } catch (error) {
    if (!(error instanceof GraphIntegrityVerificationError)) {
      logger.error("Persisted graph integrity verification error", {
        repoId,
        versionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    try {
      if (verificationRevision === null) {
        await markUnrevisionedGraphIntegrityFailedIfVerifying(
          repoId,
          versionId,
          GRAPH_INTEGRITY_VERIFICATION_FAILURE,
        );
      } else {
        await (options.persistFailureState ?? markGraphIntegrityFailedIfVerifying)(
          repoId,
          versionId,
          verificationRevision,
          GRAPH_INTEGRITY_VERIFICATION_FAILURE,
        );
      }
    } catch (stateError) {
      logger.error("Failed to persist graph integrity failure state", {
        repoId,
        versionId,
        error:
          stateError instanceof Error ? stateError.message : String(stateError),
      });
    }
    throw new GraphIntegrityVerificationError();
  }
}

export async function failGraphIntegrityVerification(
  repoId: string,
  versionId: string,
  revision: number,
): Promise<void> {
  await markGraphIntegrityFailedIfVerifying(
    repoId,
    versionId,
    revision,
    "Persisted graph integrity verification did not complete",
  );
}

function createMutableFileDigest(
  fileId: string,
  relPath: string,
): MutableFileDigest {
  return {
    fileId,
    relPath: normalizeGraphIntegrityPath(relPath),
    symbolCount: 0,
    digest: createHash("sha256"),
    pageDigest: createHash("sha256"),
    pageSymbolCount: 0,
    pageFirstSymbolId: "",
    pageLastSymbolId: "",
    pages: [],
  };
}

function normalizeGraphIntegrityPath(relPath: string): string {
  return relPath === FILELESS_SENTINEL
    ? FILELESS_SENTINEL
    : normalizePath(relPath);
}

interface AggregatedGraphIntegrityFilelessReference {
  canonicalSymbolJson: string;
  referenceCount: number;
}

function parseGraphIntegrityArray(json: string, label: string): unknown[] {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new Error(`Malformed graph integrity ${label} JSON`);
  }
  if (!Array.isArray(value)) {
    throw new Error(`Malformed graph integrity ${label} JSON`);
  }
  return value;
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function isGraphIntegritySymbolStatus(
  value: unknown,
): value is NonNullable<CanonicalSymbol["symbolStatus"]> {
  return value === "real" || value === "unresolved" || value === "external";
}

function canonicalSymbolFields(
  symbol: CanonicalSymbol,
  fileId: string,
  relPath: string,
): GraphIntegrityCanonicalSymbolTuple {
  return [
    symbol.symbolId,
    fileId,
    relPath,
    symbol.name ?? "",
    symbol.signatureJson ?? "",
    symbol.kind ?? "",
    symbol.language ?? "",
    symbol.rangeStartLine,
    symbol.rangeStartCol,
    symbol.rangeEndLine,
    symbol.rangeEndCol,
    symbol.source ?? "treesitter",
    symbol.scipSymbol ?? "",
    symbol.astFingerprint ?? "",
    symbol.symbolStatus ?? "real",
    symbol.external ?? false,
    symbol.placeholderKind ?? "",
    symbol.placeholderTarget ?? "",
  ];
}

function serializeGraphIntegrityCanonicalSymbol(
  symbol: CanonicalSymbol,
): string {
  return JSON.stringify(
    canonicalSymbolFields(symbol, FILELESS_SENTINEL, FILELESS_SENTINEL),
  );
}

function normalizeGraphIntegrityCanonicalSymbolJson(
  symbolId: string,
  json: string,
): string {
  const canonical = parseGraphIntegrityCanonicalSymbol(json);
  if (canonical.symbolId !== symbolId) {
    throw new Error("Graph integrity fileless state identity mismatch");
  }
  return serializeGraphIntegrityCanonicalSymbol(canonical);
}

function normalizeGraphIntegrityFilelessReference(
  reference: GraphIntegrityFilelessReferenceTuple,
): GraphIntegrityFilelessReferenceTuple {
  const canonicalSymbolJson = normalizeGraphIntegrityCanonicalSymbolJson(
    reference[0],
    reference[1],
  );
  if (
    (reference[2] !== null && typeof reference[2] !== "string") ||
    typeof reference[3] !== "string" ||
    (reference[4] !== "incoming" && reference[4] !== "outgoing") ||
    !Number.isSafeInteger(reference[5]) ||
    reference[5] < 0
  ) {
    throw new Error("Malformed graph integrity fileless reference");
  }
  return [
    reference[0],
    canonicalSymbolJson,
    reference[2],
    reference[3],
    reference[4],
    reference[5],
  ];
}

function aggregateGraphIntegrityFilelessReferences(
  references: readonly GraphIntegrityFilelessReferenceTuple[],
): Map<string, AggregatedGraphIntegrityFilelessReference> {
  const aggregated = new Map<string, AggregatedGraphIntegrityFilelessReference>();
  for (const input of references) {
    const reference = normalizeGraphIntegrityFilelessReference(input);
    const previous = aggregated.get(reference[0]);
    if (previous && previous.canonicalSymbolJson !== reference[1]) {
      throw new Error("Graph integrity fileless canonical symbol mismatch");
    }
    const referenceCount =
      (previous?.referenceCount ?? 0) + reference[5];
    if (!Number.isSafeInteger(referenceCount)) {
      throw new Error("Graph integrity fileless reference count is invalid");
    }
    aggregated.set(reference[0], {
      canonicalSymbolJson: reference[1],
      referenceCount,
    });
  }
  return aggregated;
}

function appendCanonicalSymbol(
  builder: MutableFileDigest,
  symbol: CanonicalSymbol,
): void {
  const serialized = `${JSON.stringify(
    canonicalSymbolFields(symbol, builder.fileId, builder.relPath),
  )}\n`;
  builder.digest.update(serialized);
  builder.pageDigest.update(serialized);
  builder.symbolCount++;
  builder.pageSymbolCount++;
  builder.pageFirstSymbolId ||= symbol.symbolId;
  builder.pageLastSymbolId = symbol.symbolId;
  if (builder.pageSymbolCount === GRAPH_INTEGRITY_PAGE_SIZE) {
    finishPage(builder);
  }
}

function finishPage(builder: MutableFileDigest): void {
  if (builder.pageSymbolCount === 0) return;
  builder.pages.push({
    symbolCount: builder.pageSymbolCount,
    firstSymbolId: builder.pageFirstSymbolId,
    lastSymbolId: builder.pageLastSymbolId,
    digest: builder.pageDigest.digest("hex"),
  });
  builder.pageDigest = createHash("sha256");
  builder.pageSymbolCount = 0;
  builder.pageFirstSymbolId = "";
  builder.pageLastSymbolId = "";
}

function finishMutableFileDigest(
  builder: MutableFileDigest,
): GraphIntegrityFileDigest {
  finishPage(builder);
  return {
    fileId: builder.fileId,
    relPath: builder.relPath,
    symbolCount: builder.symbolCount,
    digest: builder.digest.digest("hex"),
    pages: builder.pages,
  };
}

function compareFiles(
  left: GraphIntegrityFileDigest,
  right: GraphIntegrityFileDigest,
): number {
  return compareText(left.relPath, right.relPath) ||
    compareText(left.fileId, right.fileId);
}

function compareText(left: string, right: string): number {
  let leftOffset = 0;
  let rightOffset = 0;
  while (leftOffset < left.length && rightOffset < right.length) {
    const leftPoint = utf8ScalarAt(left, leftOffset);
    const rightPoint = utf8ScalarAt(right, rightOffset);
    if (leftPoint !== rightPoint) return leftPoint < rightPoint ? -1 : 1;
    leftOffset += leftPoint > 0xffff ? 2 : 1;
    rightOffset += rightPoint > 0xffff ? 2 : 1;
  }
  return leftOffset < left.length ? 1 : rightOffset < right.length ? -1 : 0;
}

function utf8ScalarAt(value: string, offset: number): number {
  const point = value.codePointAt(offset)!;
  // UTF-8 encoders replace lone surrogates; mirror that before comparison.
  return point >= 0xd800 && point <= 0xdfff ? 0xfffd : point;
}

function firstDifferentIndex<T>(
  expected: readonly T[],
  actual: readonly T[],
  equal: (left: T, right: T) => boolean,
): number {
  const length = Math.max(expected.length, actual.length);
  for (let index = 0; index < length; index++) {
    const left = expected[index];
    const right = actual[index];
    if (!left || !right || !equal(left, right)) return index;
  }
  return length;
}

function fileDigestsEqual(
  left: GraphIntegrityFileDigest,
  right: GraphIntegrityFileDigest,
): boolean {
  return left.fileId === right.fileId &&
    left.relPath === right.relPath &&
    left.symbolCount === right.symbolCount &&
    left.digest === right.digest;
}

function pageDigestsEqual(
  left: GraphIntegrityPageDigest,
  right: GraphIntegrityPageDigest,
): boolean {
  return left.symbolCount === right.symbolCount &&
    left.firstSymbolId === right.firstSymbolId &&
    left.lastSymbolId === right.lastSymbolId &&
    left.digest === right.digest;
}

function boundedFile(
  file: GraphIntegrityFileDigest | undefined,
): BoundedFileDiagnostic | null {
  return file
    ? {
        fileId: bound(file.fileId),
        relPath: bound(file.relPath),
        symbolCount: file.symbolCount,
        digest: file.digest,
      }
    : null;
}

function boundedPage(
  page: GraphIntegrityPageDigest | undefined,
): BoundedPageDiagnostic | null {
  return page
    ? {
        symbolCount: page.symbolCount,
        firstSymbolId: bound(page.firstSymbolId),
        lastSymbolId: bound(page.lastSymbolId),
        digest: page.digest,
      }
    : null;
}

function bound(value: string): string {
  return value.length <= DIAGNOSTIC_STRING_LIMIT
    ? value
    : `${value.slice(0, DIAGNOSTIC_STRING_LIMIT - 3)}...`;
}
