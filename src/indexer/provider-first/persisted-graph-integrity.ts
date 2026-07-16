import { createHash, type Hash } from "node:crypto";

import type { Connection } from "kuzu";

import {
  getDerivedState,
  graphIntegrityIsVerifiedForVersion,
  markGraphIntegrityFailed,
  markGraphIntegrityVerifying,
  markGraphIntegrityVerifiedIfVerifying,
} from "../../db/ladybug-derived-state.js";
import {
  getPersistedGraphIntegritySymbolPage,
  type GraphIntegritySymbolCursor,
} from "../../db/ladybug-graph-integrity.js";
import { getLadybugConn } from "../../db/ladybug.js";
import * as ladybugDb from "../../db/ladybug-queries.js";
import type { SymbolRow } from "../../db/ladybug-queries.js";
import { logger } from "../../util/logger.js";
import { normalizePath } from "../../util/paths.js";
import type { ProviderFirstGraphRows } from "./materializer.js";

const GRAPH_INTEGRITY_PAGE_SIZE = 512;
const GRAPH_INTEGRITY_QUERY_PAGE_SIZE = 2_048;
const DIAGNOSTIC_STRING_LIMIT = 160;
const PUBLIC_VERIFICATION_ERROR =
  "Persisted graph integrity verification failed";
const activeVerifications = new Map<string, string>();

type CanonicalSymbol = Pick<
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
  persistFailureState?: typeof markGraphIntegrityFailed;
  /** Test barrier used to prove invalidation wins after the final read. */
  afterCapture?: () => Promise<void>;
}

/**
 * Keeps the expected graph as compact file/page digests while indexer.ts
 * sequences provider-first or legacy persistence.
 */
export class PersistedGraphIntegritySession {
  private versionId: string | undefined;
  private files: Map<string, GraphIntegrityFileDigest> | undefined;

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
        throw new Error(
          'Incremental indexing requires a verified graph integrity baseline. Run sdl.index.refresh with mode:"full" first.',
        );
      }
      baselineDigest = state.graphIntegrityDigest ?? undefined;
    }

    this.versionId = targetVersionId;
    await markGraphIntegrityVerifying(this.repoId, targetVersionId);
    activeVerifications.set(this.repoId, targetVersionId);
    try {
      if (this.mode === "incremental") {
        baseline = await capturePersistedGraphIntegrity(
          await getLadybugConn(),
          this.repoId,
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
      }
      this.files = new Map(
        baseline?.files.map((file) => [file.relPath, file]) ?? [],
      );
    } catch (error) {
      await failActiveGraphIntegrityVerification(this.repoId);
      throw error instanceof GraphIntegrityVerificationError
        ? error
        : new GraphIntegrityVerificationError();
    }
  }

  applyFile(file: GraphIntegrityFileDigest): void {
    if (!this.files) return;
    if (file.symbolCount === 0) this.files.delete(file.relPath);
    else this.files.set(file.relPath, file);
  }

  applyProviderRows(rows: ProviderFirstGraphRows): void {
    if (!this.files) return;
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
  }

  removeFiles(fileIds: readonly string[]): void {
    if (!this.files || fileIds.length === 0) return;
    const removed = new Set(fileIds);
    for (const [relPath, file] of this.files) {
      if (removed.has(file.fileId)) this.files.delete(relPath);
    }
  }

  async complete(versionId: string): Promise<void> {
    if (!this.files) return;
    if (this.versionId !== versionId) {
      throw new Error("Graph integrity version changed during indexing");
    }
    const expected = createGraphIntegrityExpectation(this.files.values());
    try {
      await completeGraphIntegrityVerification(
        this.repoId,
        versionId,
        expected,
      );
    } finally {
      activeVerifications.delete(this.repoId);
      this.files = undefined;
    }
  }
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
  const versionId = activeVerifications.get(repoId);
  if (!versionId) return;
  activeVerifications.delete(repoId);
  try {
    await failGraphIntegrityVerification(repoId, versionId);
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
    normalizePath(params.relPath),
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
    if (symbol.symbolId === previousSymbolId) {
      throw new Error(
        `Graph integrity input contains duplicate symbol ${symbol.symbolId}`,
      );
    }
    appendCanonicalSymbol(builder, symbol);
    previousSymbolId = symbol.symbolId;
  }
  return finishMutableFileDigest(builder);
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
      appendCanonicalSymbol(current, {
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
  try {
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
    const published = await markGraphIntegrityVerifiedIfVerifying(
      repoId,
      versionId,
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
      await (options.persistFailureState ?? markGraphIntegrityFailed)(
        repoId,
        versionId,
        PUBLIC_VERIFICATION_ERROR,
      );
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
): Promise<void> {
  await markGraphIntegrityFailed(
    repoId,
    versionId,
    "Persisted graph integrity verification did not complete",
  );
}

function createMutableFileDigest(
  fileId: string,
  relPath: string,
): MutableFileDigest {
  return {
    fileId,
    relPath: normalizePath(relPath),
    symbolCount: 0,
    digest: createHash("sha256"),
    pageDigest: createHash("sha256"),
    pageSymbolCount: 0,
    pageFirstSymbolId: "",
    pageLastSymbolId: "",
    pages: [],
  };
}

function appendCanonicalSymbol(
  builder: MutableFileDigest,
  symbol: CanonicalSymbol,
): void {
  const serialized = `${JSON.stringify([
    symbol.symbolId,
    builder.fileId,
    builder.relPath,
    symbol.name,
    symbol.signatureJson ?? "",
    symbol.kind,
    symbol.language,
    symbol.rangeStartLine,
    symbol.rangeStartCol,
    symbol.rangeEndLine,
    symbol.rangeEndCol,
    symbol.source ?? "treesitter",
    symbol.scipSymbol ?? "",
    symbol.astFingerprint,
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
  return left < right ? -1 : left > right ? 1 : 0;
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
