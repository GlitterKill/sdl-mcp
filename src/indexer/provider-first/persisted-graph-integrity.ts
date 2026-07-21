import { createHash, type Hash } from "node:crypto";

import type { Connection } from "kuzu";

import {
  getDerivedState,
  graphIntegrityIsVerifiedForVersion,
  markCurrentGraphIntegrityRevisionFailed,
  markGraphIntegrityFailedIfVerifying,
  markGraphIntegrityVerifying,
  markGraphIntegrityVerifiedIfVerifying,
  initializeGraphIntegrityRevisionIfVerifying,
  markUnrevisionedGraphIntegrityFailedIfVerifying,
} from "../../db/ladybug-derived-state.js";
import { classifyDependencyTarget } from "../../db/symbol-placeholders.js";
import {
  getPersistedGraphIntegrityFileReferenceCounts,
  getPersistedGraphIntegrityOtherRepoSymbolCount,
  getPersistedGraphIntegrityReferenceCountPage,
  getPersistedGraphIntegritySourceReferenceCounts,
  getPersistedGraphIntegritySymbolPage,
  hasPersistedGraphIntegrityFilelessSourceReferences,
  type GraphIntegritySymbolCursor,
} from "../../db/ladybug-graph-integrity.js";
import { getLadybugConn } from "../../db/ladybug.js";
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
const GRAPH_INTEGRITY_REFERENCE_PAGE_SIZE = 2_048;
const GRAPH_INTEGRITY_FILE_ID_CHUNK_SIZE = 256;
const DIAGNOSTIC_STRING_LIMIT = 160;
const PUBLIC_VERIFICATION_ERROR =
  "Persisted graph integrity verification failed";
const INCREMENTAL_BASELINE_ERROR =
  'Incremental indexing requires a verified graph integrity baseline. Run sdl.index.refresh with mode:"full" first. If full verification also fails, stop SDL-MCP, delete the configured .lbug database directory, and rebuild from source.';
const FILELESS_SENTINEL = "";
const activeVerifications = new Map<
  string,
  { versionId: string; revision: number | null }
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

export interface GraphIntegrityEdgeWrite {
  symbolIdsToRefresh: readonly string[];
  edges: readonly EdgeRow[];
}

export interface GraphIntegrityPass1Accumulator {
  symbolMapFileUpdates: ReadonlyMap<
    string,
    { readonly symbols: readonly Pick<SymbolRow, "symbolId">[] }
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
    super(PUBLIC_VERIFICATION_ERROR);
  }
}

export interface GraphIntegrityVerificationOptions {
  persistFailureState?: typeof markGraphIntegrityFailedIfVerifying;
  /** Test barrier used to prove a newer state wins after the final read. */
  afterCapture?: () => Promise<void>;
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
  private readonly preparedBaselineFileIds = new Set<string>();
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
    affectedFileIds: readonly string[] = [],
  ): Promise<void> {
    if (!this.enabled) return;
    if (this.files) {
      if (this.versionId !== targetVersionId) {
        throw new Error("Graph integrity version changed during indexing");
      }
      await this.prepareBaselineFileReferences(affectedFileIds);
      return;
    }

    let baseline: GraphIntegrityExpectation | undefined;
    let baselineDigest: string | undefined;
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
    }

    this.versionId = targetVersionId;
    await markGraphIntegrityVerifying(this.repoId, targetVersionId);
    const verificationState = await getDerivedState(this.repoId);
    activeVerifications.set(this.repoId, {
      versionId: targetVersionId,
      revision:
        verificationState?.graphIntegrityVersionId === targetVersionId
          ? verificationState.graphIntegrityRevision ?? null
          : null,
    });
    try {
      if (this.mode === "incremental") {
        const filelessSymbols = new Map<string, CanonicalSymbol>();
        const baselineConn = await getLadybugConn();
        baseline = await capturePersistedGraphIntegrityInternal(
          baselineConn,
          this.repoId,
          (symbol) => {
            if (symbol.fileId === FILELESS_SENTINEL) {
              filelessSymbols.set(symbol.symbolId, symbol);
            }
          },
        );
        if (baseline.digest !== baselineDigest) {
          logger.error("Persisted graph integrity baseline mismatch", {
            repoId: this.repoId,
            targetVersionId,
            expectedDigest: baselineDigest,
            actualDigest: baseline.digest,
            actualSymbolCount: baseline.symbolCount,
          });
          throw new GraphIntegrityVerificationError();
        }
        this.filelessSymbols = filelessSymbols;
        this.filelessLiveness = new GraphIntegrityFilelessLivenessLedger(true);
        const otherRepoSymbolCount =
          await getPersistedGraphIntegrityOtherRepoSymbolCount(
            baselineConn,
            this.repoId,
          );
        if (
          !graphIntegrityPlaceholderPruningIsSafe(
            baseline.symbolCount,
            otherRepoSymbolCount,
          ) ||
          await hasPersistedGraphIntegrityFilelessSourceReferences(
            baselineConn,
            this.repoId,
          )
        ) {
          this.filelessLiveness.disablePruning();
        } else {
          await seedPersistedReferenceCounts(
            baselineConn,
            this.repoId,
            this.filelessLiveness,
          );
          await this.prepareBaselineFileReferences(
            affectedFileIds,
            baselineConn,
          );
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
    if (previous) this.filelessLiveness?.removeFile(previous.fileId);
    if (file.symbolCount === 0) this.files.delete(file.relPath);
    else this.files.set(file.relPath, file);
  }

  applyProviderRows(rows: ProviderFirstGraphRows): void {
    if (!this.files) return;
    this.removeFilelessSymbols(rows.symbols);
    const symbolsByFileId = new Map<string, typeof rows.symbols>();
    for (const symbol of rows.symbols) {
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
        { trackSources: this.mode === "incremental" },
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
    }
  }

  applyPass1Accumulator(accumulator: GraphIntegrityPass1Accumulator): void {
    for (const update of accumulator.symbolMapFileUpdates.values()) {
      this.removeFilelessSymbols(update.symbols);
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
        { trackSources: this.mode === "incremental" },
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
        this.filelessLiveness?.removeFile(file.fileId);
        this.files.delete(relPath);
      }
    }
  }

  private removeOutgoingReferences(
    symbolIds: readonly string[],
    edgeType: string,
  ): void {
    this.filelessLiveness?.removeOutgoing(symbolIds, edgeType);
  }

  private removeReferencesToTargets(
    symbolIds: readonly string[],
    edgeType: string,
  ): void {
    this.filelessLiveness?.removeTargets(symbolIds, edgeType);
  }

  async complete(versionId: string): Promise<void> {
    if (!this.files) return;
    if (this.versionId !== versionId) {
      throw new Error("Graph integrity version changed during indexing");
    }
    const expectedFiles = [...this.files.values()];
    if (this.filelessSymbols && this.filelessSymbols.size > 0) {
      expectedFiles.push(
        createGraphIntegrityFileDigest({
          fileId: FILELESS_SENTINEL,
          relPath: FILELESS_SENTINEL,
          symbols: [...this.filelessSymbols.values()],
        }),
      );
    }
    const expected = createGraphIntegrityExpectation(expectedFiles);
    try {
      await completeGraphIntegrityVerification(
        this.repoId,
        versionId,
        expected,
      );
    } finally {
      activeVerifications.delete(this.repoId);
      this.files = undefined;
      this.filelessSymbols = undefined;
      this.filelessLiveness = undefined;
      this.preparedBaselineFileIds.clear();
      this.pass2ApplyChain = Promise.resolve();
    }
  }

  private async prepareBaselineFileReferences(
    fileIds: readonly string[],
    conn?: Connection,
  ): Promise<void> {
    if (
      this.mode !== "incremental" ||
      !this.filelessLiveness?.canPrune ||
      fileIds.length === 0
    ) {
      return;
    }
    const uniqueFileIds = [...new Set(fileIds)].filter(
      (fileId) => !this.preparedBaselineFileIds.has(fileId),
    );
    if (uniqueFileIds.length === 0) return;
    const readConn = conn ?? await getLadybugConn();
    for (let offset = 0; offset < uniqueFileIds.length; offset += GRAPH_INTEGRITY_FILE_ID_CHUNK_SIZE) {
      const chunk = uniqueFileIds.slice(
        offset,
        offset + GRAPH_INTEGRITY_FILE_ID_CHUNK_SIZE,
      );
      const rows = await getPersistedGraphIntegrityFileReferenceCounts(
        readConn,
        this.repoId,
        chunk,
      );
      for (const row of rows) {
        this.filelessLiveness.seedFileReferenceCount(row.fileId, row);
      }
      for (const fileId of chunk) this.preparedBaselineFileIds.add(fileId);
    }
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
      for (const row of rows) {
        this.filelessLiveness.seedCurrentSourceReference(
          row.sourceSymbolId,
          row,
        );
      }
      for (const symbolId of chunk) {
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
      PUBLIC_VERIFICATION_ERROR,
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
  if (revision === null) return;
  try {
    await failGraphIntegrityVerification(repoId, versionId, revision);
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

/**
 * Build canonical fileless Symbol rows from provider externals and non-real
 * dependency targets before persistence. Real cross-file targets are omitted:
 * their authoritative file-backed rows are already included per file.
 */
export function createGraphIntegrityFilelessSymbols(rows: {
  symbols: readonly Pick<SymbolRow, "symbolId">[];
  externalSymbols: readonly ProviderFirstExternalSymbolRow[];
  edges: readonly EdgeRow[];
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
    fileless.set(edge.toSymbolId, {
      symbolId: edge.toSymbolId,
      fileId: FILELESS_SENTINEL,
      name: edge.toSymbolId,
      kind: "unknown",
      language: "unknown",
      rangeStartLine: 0,
      rangeStartCol: 0,
      rangeEndLine: 0,
      rangeEndCol: 0,
      signatureJson: null,
      source: "treesitter",
      scipSymbol: null,
      astFingerprint: edge.toSymbolId,
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

async function seedPersistedReferenceCounts(
  conn: Connection,
  repoId: string,
  ledger: GraphIntegrityFilelessLivenessLedger,
): Promise<void> {
  let after: { symbolId: string; edgeType: string } | undefined;
  while (true) {
    const rows = await getPersistedGraphIntegrityReferenceCountPage(conn, {
      repoId,
      after,
      limit: GRAPH_INTEGRITY_REFERENCE_PAGE_SIZE,
    });
    if (rows.length === 0) return;
    for (const row of rows) ledger.seedReferenceCount(row);
    const last = rows.at(-1)!;
    after = { symbolId: last.symbolId, edgeType: last.edgeType };
  }
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
): Promise<GraphIntegrityExpectation> {
  return capturePersistedGraphIntegrityInternal(conn, repoId);
}

async function capturePersistedGraphIntegrityInternal(
  conn: Connection,
  repoId: string,
  onSymbol?: (symbol: CanonicalSymbol) => void,
): Promise<GraphIntegrityExpectation> {
  const files: GraphIntegrityFileDigest[] = [];
  let current: MutableFileDigest | undefined;
  let cursor: GraphIntegritySymbolCursor | undefined;

  while (true) {
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
  let verificationRevision: number | null = null;
  try {
    const verificationState = await getDerivedState(repoId);
    if (
      !verificationState ||
      verificationState.graphIntegrityState !== "verifying" ||
      verificationState.graphIntegrityVersionId !== versionId
    ) {
      throw new GraphIntegrityVerificationError();
    }
    verificationRevision = verificationState.graphIntegrityRevision ?? null;

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
          PUBLIC_VERIFICATION_ERROR,
        );
      } else {
        await (options.persistFailureState ?? markGraphIntegrityFailedIfVerifying)(
          repoId,
          versionId,
          verificationRevision,
          PUBLIC_VERIFICATION_ERROR,
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

function appendCanonicalSymbol(
  builder: MutableFileDigest,
  symbol: CanonicalSymbol,
): void {
  const serialized = `${JSON.stringify([
    symbol.symbolId,
    builder.fileId,
    builder.relPath,
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
  ])}\n`;
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
