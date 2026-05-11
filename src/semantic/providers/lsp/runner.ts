import { randomUUID } from "node:crypto";
import type { Dirent, Stats } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { Connection } from "kuzu";
import type {
  DefinitionParams,
  Diagnostic,
  InitializeResult,
  Location,
  LocationLink,
} from "vscode-languageserver-protocol";

import type { SemanticEnrichmentLspServerConfig } from "../../../config/types.js";
import type {
  SemanticEdge,
  SemanticDiagnostic,
  SemanticIndex,
  SemanticProviderRun,
  SemanticRange,
  SemanticSymbol,
} from "../../types.js";
import { getRelativePath, normalizePath } from "../../../util/paths.js";
import {
  type LspCallDefinitionCandidate,
  type LspCandidateDocument,
  type LspCandidatePlan,
  type LspCandidateSkip,
  planLspCallDefinitionCandidates,
} from "./candidates.js";
import {
  SemanticLspClient,
  type LspClientOptions,
  type LspTextDocument,
} from "./client.js";

export interface SemanticLspClientLike {
  start(timeoutMs?: number): Promise<InitializeResult>;
  openDocument(document: LspTextDocument): Promise<void>;
  definition(
    params: DefinitionParams,
    timeoutMs?: number,
  ): Promise<Location | Location[] | LocationLink[] | null>;
  diagnostics?(uri: string): Diagnostic[];
  pullDiagnostics?(uri: string, timeoutMs?: number): Promise<Diagnostic[]>;
  waitForDiagnostics?(
    uris: readonly string[],
    timeoutMs: number,
  ): Promise<void>;
  dispose(): Promise<void>;
}

export interface RunLspCallDefinitionEnrichmentOptions {
  conn: Connection;
  repoId: string;
  repoRoot: string;
  languageId: string;
  server: SemanticEnrichmentLspServerConfig;
  serverKey?: string;
  providerVersion?: string;
  confidence: number;
  timeoutMs: number;
  candidateLimit: number;
  candidatePlanner?: () => Promise<LspCandidatePlan>;
  clientFactory?: (options: LspClientOptions) => SemanticLspClientLike;
  runId?: string;
}

export interface LspCallDefinitionEnrichmentResult {
  index?: SemanticIndex;
  failedRun?: SemanticProviderRun;
  skippedRun?: SemanticProviderRun;
  skipped: LspCandidateSkip[];
  candidateCount: number;
}

interface ResolvedDefinition {
  candidate: LspCallDefinitionCandidate;
  targetSymbol: SemanticSymbol;
}

const MAX_CONFIGURED_LSP_DOCUMENTS = 500;
const MAX_LSP_WALK_ENTRIES = 20_000;
const MAX_LSP_FILE_BYTES = 512 * 1024;
const MAX_LSP_TOTAL_BYTES = 20 * 1024 * 1024;
const MAX_LSP_DIAGNOSTICS = 5_000;
const MAX_LSP_DIAGNOSTICS_PER_FILE = 200;
const MAX_LSP_DIAGNOSTIC_MESSAGE_CHARS = 1_000;
const LSP_DIAGNOSTIC_WAIT_MS = 2_000;

export async function runLspCallDefinitionEnrichment(
  options: RunLspCallDefinitionEnrichmentOptions,
): Promise<LspCallDefinitionEnrichmentResult> {
  const runId = options.runId ?? randomUUID();
  const providerId = options.server.serverId || options.serverKey || "lsp";
  const deadlineMs = Date.now() + options.timeoutMs;
  const plan =
    options.candidatePlanner?.() ??
    planLspCallDefinitionCandidates({
      conn: options.conn,
      repoId: options.repoId,
      repoRoot: options.repoRoot,
      languageId: options.languageId,
      candidateLimit: options.candidateLimit,
    });
  const candidatePlan = await plan;
  const skipped = [...candidatePlan.skipped];
  const documents = mergeDocuments([
    ...candidatePlan.documents,
    ...(await collectConfiguredDocuments({
      repoRoot: options.repoRoot,
      languageId: options.languageId,
      server: options.server,
    })),
  ]);

  if (documents.length === 0 && candidatePlan.candidates.length === 0) {
    return {
      skippedRun: buildSkippedRun({
        repoId: options.repoId,
        runId,
        providerId,
        providerVersion: options.providerVersion,
        languageId: options.languageId,
        documentsProcessed: 0,
        candidateCount: 0,
        skippedCount: skipped.length,
        reason: "no matching documents for configured LSP server",
      }),
      skipped,
      candidateCount: 0,
    };
  }

  const clientFactory =
    options.clientFactory ??
    ((clientOptions: LspClientOptions) => new SemanticLspClient(clientOptions));
  const client = clientFactory({
    serverId: providerId,
    command: options.server.command,
    args: options.server.args,
    workspaceRoot: options.repoRoot,
    timeoutMs: options.timeoutMs,
    initializationOptions: options.server.initializationOptions,
  });

  try {
    const initializeResult = await client.start(remainingTimeoutMs(deadlineMs));
    const canRunDefinitions =
      candidatePlan.candidates.length > 0 &&
      supportsDefinition(initializeResult);
    const canPullDiagnostics =
      documents.length > 0 &&
      typeof client.pullDiagnostics === "function" &&
      supportsDiagnostics(initializeResult);
    const canCollectDiagnostics =
      documents.length > 0 &&
      typeof client.diagnostics === "function" &&
      (canPullDiagnostics || serverRequestsDiagnostics(options.server));

    if (!canRunDefinitions && !canCollectDiagnostics) {
      skipped.push(
        ...candidatePlan.candidates.map((candidate) =>
          skipCandidate(candidate, "definition-unavailable"),
        ),
      );
      return {
        skippedRun: buildSkippedRun({
          repoId: options.repoId,
          runId,
          providerId,
          providerVersion: options.providerVersion,
          languageId: options.languageId,
          documentsProcessed: documents.length,
          candidateCount: candidatePlan.candidates.length,
          skippedCount: skipped.length,
          reason:
            "server did not advertise diagnostic or definition capabilities",
        }),
        skipped,
        candidateCount: candidatePlan.candidates.length,
      };
    }

    for (const document of documents) {
      await client.openDocument(documentToLspTextDocument(document));
    }

    if (canPullDiagnostics && client.pullDiagnostics) {
      await pullDocumentDiagnostics({
        client,
        documents,
        deadlineMs: Math.min(deadlineMs, Date.now() + LSP_DIAGNOSTIC_WAIT_MS),
      });
    } else if (canCollectDiagnostics && client.waitForDiagnostics) {
      const waitMs = Math.min(
        remainingTimeoutMs(deadlineMs),
        LSP_DIAGNOSTIC_WAIT_MS,
      );
      if (waitMs > 0) {
        await client.waitForDiagnostics(
          documents.map((document) => document.uri),
          waitMs,
        );
      }
    }
    const lspDiagnostics = canCollectDiagnostics
      ? collectDiagnostics({
          client,
          documents,
          repoId: options.repoId,
          runId,
          providerId,
        })
      : [];

    const resolved: ResolvedDefinition[] = [];
    if (canRunDefinitions) {
      for (const candidate of candidatePlan.candidates) {
        const remainingMs = remainingTimeoutMs(deadlineMs);
        if (remainingMs <= 0) {
          skipped.push(skipCandidate(candidate, "definition-failed"));
          continue;
        }
        try {
          const definitions = await client.definition(
            {
              textDocument: { uri: candidate.sourceUri },
              position: candidate.position,
            },
            remainingMs,
          );
          const target = firstInRepoDefinition({
            definitions,
            repoRoot: options.repoRoot,
            runId,
            providerId,
            languageId: options.languageId,
            candidate,
          });
          if (!target) {
            skipped.push(skipCandidate(candidate, "definition-not-found"));
            continue;
          }
          resolved.push({ candidate, targetSymbol: target });
        } catch {
          skipped.push(skipCandidate(candidate, "definition-failed"));
        }
      }
    } else {
      skipped.push(
        ...candidatePlan.candidates.map((candidate) =>
          skipCandidate(candidate, "definition-unavailable"),
        ),
      );
    }

    return {
      index: buildSemanticIndex({
        repoId: options.repoId,
        runId,
        providerId,
        providerVersion:
          options.providerVersion ?? initializeResult.serverInfo?.version,
        languageId: options.languageId,
        documents,
        resolved,
        diagnostics: lspDiagnostics,
        confidence: options.confidence,
      }),
      skipped,
      candidateCount: candidatePlan.candidates.length,
    };
  } catch (error) {
    return {
      failedRun: buildFailedRun({
        repoId: options.repoId,
        runId,
        providerId,
        providerVersion: options.providerVersion,
        languageId: options.languageId,
        candidateCount: candidatePlan.candidates.length,
        skippedCount: skipped.length,
        error,
      }),
      skipped,
      candidateCount: candidatePlan.candidates.length,
    };
  } finally {
    await client.dispose().catch(() => undefined);
  }
}

export function buildSemanticIndexFromLspDefinitions(params: {
  repoId: string;
  runId: string;
  providerId: string;
  providerVersion?: string;
  languageId: string;
  documents: readonly LspCandidateDocument[];
  resolved: readonly ResolvedDefinition[];
  diagnostics?: readonly SemanticDiagnostic[];
  confidence: number;
}): SemanticIndex {
  return buildSemanticIndex(params);
}

function supportsDefinition(result: InitializeResult): boolean {
  return Boolean(result.capabilities.definitionProvider);
}

function supportsDiagnostics(result: InitializeResult): boolean {
  return Boolean(result.capabilities.diagnosticProvider);
}

function serverRequestsDiagnostics(
  server: SemanticEnrichmentLspServerConfig,
): boolean {
  return server.capabilities.some((capability) =>
    /diagnostics?/iu.test(capability),
  );
}

function documentToLspTextDocument(
  document: LspCandidateDocument,
): LspTextDocument {
  return {
    uri: document.uri,
    languageId: document.languageId,
    version: document.version,
    text: document.text,
  };
}

async function collectConfiguredDocuments(params: {
  repoRoot: string;
  languageId: string;
  server: SemanticEnrichmentLspServerConfig;
}): Promise<LspCandidateDocument[]> {
  if (params.server.filePatterns.length === 0) return [];

  const documents: LspCandidateDocument[] = [];
  let aggregateBytes = 0;
  for await (const sourcePath of walkRepoFiles(params.repoRoot)) {
    if (
      !params.server.filePatterns.some((pattern) =>
        matchesFilePattern(sourcePath, pattern),
      )
    ) {
      continue;
    }
    const absolutePath = join(params.repoRoot, sourcePath);
    let fileStat: Stats;
    try {
      fileStat = await stat(absolutePath);
    } catch {
      continue;
    }
    if (!fileStat.isFile() || fileStat.size > MAX_LSP_FILE_BYTES) continue;
    if (aggregateBytes + fileStat.size > MAX_LSP_TOTAL_BYTES) break;
    let text: string;
    try {
      text = await readFile(absolutePath, "utf8");
      aggregateBytes += fileStat.size;
    } catch {
      continue;
    }
    documents.push({
      uri: pathToFileURL(absolutePath).toString(),
      sourcePath: normalizePath(sourcePath),
      languageId: documentLanguageIdForPath(
        sourcePath,
        params.server.documentLanguageIds,
        params.languageId,
      ),
      text,
      version: 1,
    });
    if (documents.length >= MAX_CONFIGURED_LSP_DOCUMENTS) break;
  }
  return documents;
}

interface LspWalkState {
  visitedEntries: number;
}

async function* walkRepoFiles(
  root: string,
  relativeDir = "",
  state: LspWalkState = { visitedEntries: 0 },
): AsyncGenerator<string> {
  if (state.visitedEntries >= MAX_LSP_WALK_ENTRIES) return;
  const absoluteDir = join(root, relativeDir);
  let entries: Dirent[];
  try {
    entries = await readdir(absoluteDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    state.visitedEntries += 1;
    if (state.visitedEntries > MAX_LSP_WALK_ENTRIES) return;
    const relativePath = normalizePath(join(relativeDir, entry.name));
    if (entry.isDirectory()) {
      if (shouldSkipLspScanDirectory(entry.name)) continue;
      yield* walkRepoFiles(root, relativePath, state);
    } else if (entry.isFile()) {
      yield relativePath;
    }
  }
}

function shouldSkipLspScanDirectory(name: string): boolean {
  return new Set([
    ".git",
    ".hg",
    ".svn",
    "node_modules",
    "target",
    "vendor",
    ".venv",
    "venv",
    "__pycache__",
    ".gradle",
    ".idea",
    "build",
    "dist",
    ".tmp",
    ".worktrees",
    ".sisyphus",
    ".codex",
    ".claude",
  ]).has(name.toLowerCase());
}

function matchesFilePattern(sourcePath: string, pattern: string): boolean {
  const normalizedPath = normalizePath(sourcePath).toLowerCase();
  const normalizedPattern = normalizePath(pattern).toLowerCase();
  if (normalizedPattern.startsWith("**/*.")) {
    return normalizedPath.endsWith(normalizedPattern.slice("**/*".length));
  }
  if (
    normalizedPattern.startsWith("**/") &&
    normalizedPattern.endsWith("/**/*")
  ) {
    const directory = normalizedPattern.slice(3, -"**/*".length);
    return (
      normalizedPath.startsWith(directory) ||
      normalizedPath.includes(`/${directory}`)
    );
  }
  if (normalizedPattern.startsWith("**/")) {
    return normalizedPath.endsWith(normalizedPattern.slice(3));
  }
  return normalizedPath === normalizedPattern;
}

function documentLanguageIdForPath(
  sourcePath: string,
  configuredIds: readonly string[],
  fallback: string,
): string {
  const extension = extname(sourcePath).toLowerCase();
  if (configuredIds.length === 0) return fallback;
  if (extension === ".tsx" && configuredIds.includes("typescriptreact")) {
    return "typescriptreact";
  }
  if (extension === ".jsx" && configuredIds.includes("javascriptreact")) {
    return "javascriptreact";
  }
  if (
    [".js", ".mjs", ".cjs"].includes(extension) &&
    configuredIds.includes("javascript")
  ) {
    return "javascript";
  }
  if (
    [".ts", ".mts", ".cts"].includes(extension) &&
    configuredIds.includes("typescript")
  ) {
    return "typescript";
  }
  return configuredIds[0] ?? fallback;
}

function mergeDocuments(
  documents: readonly LspCandidateDocument[],
): LspCandidateDocument[] {
  const byUri = new Map<string, LspCandidateDocument>();
  for (const document of documents) {
    byUri.set(document.uri, document);
  }
  return [...byUri.values()];
}

function collectDiagnostics(params: {
  client: SemanticLspClientLike;
  documents: readonly LspCandidateDocument[];
  repoId: string;
  runId: string;
  providerId: string;
}): SemanticDiagnostic[] {
  if (!params.client.diagnostics) return [];
  const diagnostics: SemanticDiagnostic[] = [];
  let totalDiagnostics = 0;

  for (const document of params.documents) {
    if (totalDiagnostics >= MAX_LSP_DIAGNOSTICS) break;
    const values = params.client
      .diagnostics(document.uri)
      .slice(0, MAX_LSP_DIAGNOSTICS_PER_FILE);
    for (const [index, diagnostic] of values.entries()) {
      if (totalDiagnostics >= MAX_LSP_DIAGNOSTICS) break;
      diagnostics.push({
        id: `lsp-diagnostic:${params.runId}:${params.providerId}:${document.sourcePath}:${index}`,
        repoId: params.repoId,
        runId: params.runId,
        providerType: "lsp",
        providerId: params.providerId,
        languageId: document.languageId,
        sourcePath: document.sourcePath,
        severity: diagnosticSeverity(diagnostic.severity),
        message: diagnostic.message.slice(0, MAX_LSP_DIAGNOSTIC_MESSAGE_CHARS),
        code:
          diagnostic.code === undefined ? undefined : String(diagnostic.code),
        range: diagnostic.range
          ? lspRangeToSemanticRange(diagnostic.range)
          : undefined,
      });
      totalDiagnostics += 1;
    }
  }
  return diagnostics;
}

async function pullDocumentDiagnostics(params: {
  client: SemanticLspClientLike;
  documents: readonly LspCandidateDocument[];
  deadlineMs: number;
}): Promise<void> {
  if (!params.client.pullDiagnostics) return;
  for (const document of params.documents) {
    const timeoutMs = remainingTimeoutMs(params.deadlineMs);
    if (timeoutMs <= 0) return;
    await params.client
      .pullDiagnostics(document.uri, timeoutMs)
      .catch(() => undefined);
  }
}

function diagnosticSeverity(
  severity: Diagnostic["severity"],
): SemanticDiagnostic["severity"] {
  switch (severity) {
    case 1:
      return "error";
    case 2:
      return "warning";
    case 3:
      return "information";
    case 4:
      return "hint";
    default:
      return "information";
  }
}

function firstInRepoDefinition(params: {
  definitions: Location | Location[] | LocationLink[] | null;
  repoRoot: string;
  runId: string;
  providerId: string;
  languageId: string;
  candidate: LspCallDefinitionCandidate;
}): SemanticSymbol | null {
  const definitions = normalizeDefinitions(params.definitions);
  for (let i = 0; i < definitions.length; i++) {
    const definition = definitions[i];
    const sourcePath = repoPathFromUri(definition.uri, params.repoRoot);
    if (!sourcePath) continue;
    const range = lspRangeToSemanticRange(definition.range);
    return {
      providerSymbolId: `lsp-target:${params.runId}:${params.candidate.sourceSymbolId}:${i}`,
      name: params.candidate.targetName,
      kind: "definition",
      languageId: params.languageId,
      sourcePath,
      range,
    };
  }
  return null;
}

function normalizeDefinitions(
  definitions: Location | Location[] | LocationLink[] | null,
): Array<{ uri: string; range: DefinitionRange }> {
  if (!definitions) return [];
  const values = Array.isArray(definitions) ? definitions : [definitions];
  return values
    .map((definition) => {
      if (isLocationLink(definition)) {
        return {
          uri: definition.targetUri,
          range: definition.targetSelectionRange ?? definition.targetRange,
        };
      }
      return {
        uri: definition.uri,
        range: definition.range,
      };
    })
    .filter((definition) => Boolean(definition.uri && definition.range));
}

interface DefinitionRange {
  start: { line: number; character: number };
  end: { line: number; character: number };
}

function isLocationLink(value: Location | LocationLink): value is LocationLink {
  return "targetUri" in value;
}

function repoPathFromUri(uri: string, repoRoot: string): string | null {
  let absolutePath: string;
  try {
    absolutePath = fileURLToPath(uri);
  } catch {
    return null;
  }
  const relPath = normalizePath(getRelativePath(repoRoot, absolutePath));
  if (
    relPath === "" ||
    relPath.startsWith("..") ||
    /^[A-Za-z]:\//.test(relPath)
  ) {
    return null;
  }
  return relPath;
}

function lspRangeToSemanticRange(range: DefinitionRange): SemanticRange {
  return {
    startLine: range.start.line,
    startCol: range.start.character,
    endLine: range.end.line,
    endCol: range.end.character,
  };
}

function buildSemanticIndex(params: {
  repoId: string;
  runId: string;
  providerId: string;
  providerVersion?: string;
  languageId: string;
  documents: readonly LspCandidateDocument[];
  resolved: readonly ResolvedDefinition[];
  symbols?: readonly SemanticSymbol[];
  diagnostics?: readonly SemanticDiagnostic[];
  confidence: number;
}): SemanticIndex {
  const documents = new Map<string, LspCandidateDocument>();
  for (const document of params.documents) {
    documents.set(document.sourcePath, document);
  }
  for (const item of params.resolved) {
    if (!item.targetSymbol.sourcePath) continue;
    documents.set(item.targetSymbol.sourcePath, {
      uri: "",
      sourcePath: item.targetSymbol.sourcePath,
      languageId: params.languageId,
      text: "",
      version: 1,
    });
  }

  const sourceSymbols: SemanticSymbol[] = [];
  const sourceSymbolIds = new Set<string>();
  for (const item of params.resolved) {
    if (sourceSymbolIds.has(item.candidate.sourceProviderSymbolId)) continue;
    sourceSymbolIds.add(item.candidate.sourceProviderSymbolId);
    sourceSymbols.push({
      providerSymbolId: item.candidate.sourceProviderSymbolId,
      sdlSymbolId: item.candidate.sourceSymbolId,
      name: item.candidate.sourceName,
      languageId: item.candidate.languageId,
      sourcePath: item.candidate.sourcePath,
    });
  }

  const targetSymbols = params.resolved.map((item) => item.targetSymbol);
  const edges: SemanticEdge[] = params.resolved.map((item) => {
    // Preserve writer semantics for same-target heuristic edges: exact LSP
    // evidence should not lose to a higher prior heuristic confidence.
    const confidence = Math.max(
      params.confidence,
      item.candidate.existingEdgeConfidence,
    );
    return {
      sourceProviderSymbolId: item.candidate.sourceProviderSymbolId,
      targetProviderSymbolId: item.targetSymbol.providerSymbolId,
      edgeType: "call",
      replaceTargetSymbolId: item.candidate.targetSymbolId,
      confidence,
      resolution: "exact",
      resolverId: `lsp:${params.providerId}`,
      resolutionPhase: "semantic-enrichment:lsp",
      capability: "definition",
      provenance: {
        providerType: "lsp",
        providerId: params.providerId,
        capability: "definition",
        confidence,
        runId: params.runId,
        resolutionPhase: "semantic-enrichment:lsp",
      },
    };
  });

  return {
    repoId: params.repoId,
    runId: params.runId,
    providerType: "lsp",
    providerId: params.providerId,
    providerVersion: params.providerVersion,
    generatedAt: new Date().toISOString(),
    documents: [...documents.values()].map((document) => ({
      languageId: document.languageId,
      sourcePath: document.sourcePath,
      sourceHash: document.sourceHash,
      occurrences: [],
      diagnostics: [],
    })),
    symbols: [...sourceSymbols, ...targetSymbols],
    edges,
    diagnostics: [...(params.diagnostics ?? [])],
  };
}

function remainingTimeoutMs(deadlineMs: number): number {
  return Math.max(0, deadlineMs - Date.now());
}

function skipCandidate(
  candidate: LspCallDefinitionCandidate,
  reason: LspCandidateSkip["reason"],
): LspCandidateSkip {
  return {
    reason,
    languageId: candidate.languageId,
    sourcePath: candidate.sourcePath,
    sourceSymbolId: candidate.sourceSymbolId,
    targetSymbolId: candidate.targetSymbolId,
    targetName: candidate.targetName,
  };
}

function buildFailedRun(params: {
  repoId: string;
  runId: string;
  providerId: string;
  providerVersion?: string;
  languageId: string;
  candidateCount: number;
  skippedCount: number;
  error: unknown;
}): SemanticProviderRun {
  const now = new Date().toISOString();
  return {
    runId: params.runId,
    repoId: params.repoId,
    providerType: "lsp",
    providerId: params.providerId,
    providerVersion: params.providerVersion,
    languages: [params.languageId],
    status: "failed",
    startedAt: now,
    finishedAt: now,
    documentsProcessed: 0,
    symbolsMatched: 0,
    edgesCreated: 0,
    edgesUpgraded: 0,
    edgesReplaced: 0,
    edgesSkipped: params.candidateCount + params.skippedCount,
    diagnosticsCount: 0,
    precisionScore: 0,
    error:
      params.error instanceof Error
        ? params.error.message
        : String(params.error),
  };
}

function buildSkippedRun(params: {
  repoId: string;
  runId: string;
  providerId: string;
  providerVersion?: string;
  languageId: string;
  documentsProcessed: number;
  candidateCount: number;
  skippedCount: number;
  reason: string;
}): SemanticProviderRun {
  const now = new Date().toISOString();
  return {
    runId: params.runId,
    repoId: params.repoId,
    providerType: "lsp",
    providerId: params.providerId,
    providerVersion: params.providerVersion,
    languages: [params.languageId],
    status: "skipped",
    startedAt: now,
    finishedAt: now,
    documentsProcessed: params.documentsProcessed,
    symbolsMatched: 0,
    edgesCreated: 0,
    edgesUpgraded: 0,
    edgesReplaced: 0,
    edgesSkipped: params.candidateCount + params.skippedCount,
    diagnosticsCount: 0,
    precisionScore: 0,
    error: params.reason,
  };
}
