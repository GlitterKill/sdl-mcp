import { readFileSync } from "fs";
import { mkdir, readdir, readFile, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { promisify } from "util";
import { gzip, gunzip, gunzipSync } from "zlib";

import { getKuzuConn } from "../db/kuzu.js";
import * as kuzuDb from "../db/kuzu-queries.js";
import { resolveSymbolEnrichment } from "../indexer/symbol-enrichment.js";
import { hashContent } from "../util/hashing.js";
import { getCurrentTimestamp } from "../util/time.js";
import type {
  SyncArtifact,
  SyncArtifactMetadata,
  SyncExportOptions,
  SyncExportResult,
  SyncImportOptions,
  SyncImportResult,
  SyncIndexState,
} from "./types.js";

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

export async function exportArtifact(
  options: SyncExportOptions,
): Promise<SyncExportResult> {
  const startTime = Date.now();
  const conn = await getKuzuConn();

  const repo = await kuzuDb.getRepo(conn, options.repoId);
  if (!repo) {
    throw new Error(`Repository not found: ${options.repoId}`);
  }

  const versionId =
    options.versionId ??
    (await kuzuDb.getLatestVersion(conn, options.repoId))?.versionId;
  if (!versionId) {
    throw new Error(
      `No version found for repository: ${options.repoId}. Please index the repository first.`,
    );
  }

  const version = await kuzuDb.getVersion(conn, versionId);
  if (!version) {
    throw new Error(`Version not found: ${versionId}`);
  }

  const commitSha = options.commitSha ?? (await getGitCommitSha(repo.rootPath));

  const files = await kuzuDb.getFilesByRepo(conn, options.repoId);
  const symbolIds = await kuzuDb.getSymbolIdsByRepo(conn, options.repoId);

  // Fetch full symbols in chunks
  const symbols: import("../db/kuzu-queries.js").SymbolRow[] = [];
  const SYMBOL_CHUNK_SIZE = 200;
  for (let i = 0; i < symbolIds.length; i += SYMBOL_CHUNK_SIZE) {
    const chunkIds = symbolIds.slice(i, i + SYMBOL_CHUNK_SIZE);
    const chunkMap = await kuzuDb.getSymbolsByIds(conn, chunkIds);
    symbols.push(...chunkMap.values());
  }

  // Fetch edges in chunks to avoid KuzuDB buffer pool exhaustion on large repos
  const edges: import("../db/kuzu-queries.js").EdgeRow[] = [];
  const EDGE_CHUNK_SIZE = 200;
  for (let i = 0; i < symbolIds.length; i += EDGE_CHUNK_SIZE) {
    const chunkIds = symbolIds.slice(i, i + EDGE_CHUNK_SIZE);
    const chunkMap = await kuzuDb.getEdgesFromSymbols(conn, chunkIds);
    for (const idEdges of chunkMap.values()) {
      edges.push(...idEdges);
    }
  }

  const symbolVersions = await kuzuDb.getSymbolVersionsAtVersion(conn, versionId);

  const metricsMap = new Map();
  const METRICS_CHUNK_SIZE = 200;
  for (let i = 0; i < symbolIds.length; i += METRICS_CHUNK_SIZE) {
    const chunkMap = await kuzuDb.getMetricsBySymbolIds(
      conn,
      symbolIds.slice(i, i + METRICS_CHUNK_SIZE),
    );
    for (const [k, v] of chunkMap) {
      metricsMap.set(k, v);
    }
  }
  const metrics = Array.from(metricsMap.values());

  const state: SyncIndexState = {
    repo_id: options.repoId,
    version_id: versionId,
    version_hash: version.versionHash,
    prev_version_hash: version.prevVersionHash,
    files: files.map((f) => ({
      file_id: f.fileId,
      rel_path: f.relPath,
      content_hash: f.contentHash,
      language: f.language,
      byte_size: f.byteSize,
    })),
    symbols: symbols.map((s) => ({
      symbol_id: s.symbolId,
      file_id: s.fileId,
      kind: s.kind,
      name: s.name,
      exported: s.exported ? 1 : 0,
      visibility: s.visibility,
      language: s.language,
      range_start_line: s.rangeStartLine,
      range_start_col: s.rangeStartCol,
      range_end_line: s.rangeEndLine,
      range_end_col: s.rangeEndCol,
      ast_fingerprint: s.astFingerprint,
      signature_json: s.signatureJson,
      summary: s.summary,
      invariants_json: s.invariantsJson,
      side_effects_json: s.sideEffectsJson,
      role_tags_json: s.roleTagsJson ?? null,
      search_text: s.searchText ?? null,
      updated_at: s.updatedAt,
    })),
    symbol_versions: symbolVersions.map((sv) => ({
      version_id: sv.versionId,
      symbol_id: sv.symbolId,
      ast_fingerprint: sv.astFingerprint,
      signature_json: sv.signatureJson,
      summary: sv.summary,
      invariants_json: sv.invariantsJson,
      side_effects_json: sv.sideEffectsJson,
    })),
    edges: edges.map((e) => ({
      repo_id: e.repoId,
      from_symbol_id: e.fromSymbolId,
      to_symbol_id: e.toSymbolId,
      type: e.edgeType as "import" | "call" | "config",
      weight: e.weight,
      confidence: e.confidence,
      resolution: e.resolution,
      provenance: e.provenance,
      created_at: e.createdAt,
    })),
    metrics: metrics.map((m) => ({
      symbol_id: m.symbolId,
      fan_in: m.fanIn,
      fan_out: m.fanOut,
      churn_30d: m.churn30d,
      test_refs_json: m.testRefsJson,
      canonical_test_json: m.canonicalTestJson,
      updated_at: m.updatedAt,
    })),
  };

  const stateJson = JSON.stringify(state, null, 0);
  const compressed = await gzipAsync(Buffer.from(stateJson));
  const artifactHash = hashContent(stateJson);

  const artifactId = `${options.repoId}-${commitSha ?? "manual"}-${artifactHash.slice(0, 12)}`;

  const artifact: SyncArtifact = {
    artifact_id: artifactId,
    repo_id: options.repoId,
    version_id: versionId,
    commit_sha: commitSha,
    branch: options.branch ?? (await getGitBranch(repo.rootPath)),
    artifact_hash: artifactHash,
    compressed_data: compressed.toString("base64"),
    created_at: getCurrentTimestamp(),
    size_bytes: compressed.length,
  };

  const outputPath =
    options.outputPath ??
    join(process.cwd(), ".sdl-sync", `${artifactId}.sdl-artifact.json`);

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(artifact, null, 2), "utf-8");

  await kuzuDb.upsertSyncArtifact(conn, {
    artifactId,
    repoId: options.repoId,
    versionId,
    commitSha: artifact.commit_sha,
    branch: artifact.branch,
    artifactHash,
    compressedData: artifact.compressed_data,
    createdAt: artifact.created_at,
    sizeBytes: artifact.size_bytes,
  });

  const durationMs = Date.now() - startTime;

  return {
    artifactId,
    artifactPath: outputPath,
    versionId,
    commitSha,
    fileCount: state.files.length,
    symbolCount: state.symbols.length,
    edgeCount: state.edges.length,
    sizeBytes: compressed.length,
    durationMs,
  };
}

export async function importArtifact(
  options: SyncImportOptions,
): Promise<SyncImportResult> {
  const startTime = Date.now();
  const conn = await getKuzuConn();

  const artifactContent = await readFile(options.artifactPath, "utf-8");
  const artifact: SyncArtifact = JSON.parse(artifactContent);

  if (options.repoId && artifact.repo_id !== options.repoId) {
    if (!options.force) {
      throw new Error(
        `Artifact repo_id (${artifact.repo_id}) does not match expected repo_id (${options.repoId}). Use --force to override.`,
      );
    }
  }

  const compressed = Buffer.from(artifact.compressed_data, "base64");
  const decompressed = await gunzipAsync(compressed);
  const state: SyncIndexState = JSON.parse(decompressed.toString("utf-8"));
  const relPathByFileId = new Map(
    state.files.map((file) => [file.file_id, file.rel_path] as const),
  );

  if (options.verifyIntegrity) {
    const computedHash = hashContent(JSON.stringify(state, null, 0));
    if (computedHash !== artifact.artifact_hash) {
      throw new Error("Artifact integrity check failed: hash mismatch");
    }
  }

  const existingRepo = await kuzuDb.getRepo(conn, artifact.repo_id);
  if (!existingRepo) {
    await kuzuDb.upsertRepo(conn, {
      repoId: artifact.repo_id,
      rootPath: "",
      configJson: "{}",
      createdAt: getCurrentTimestamp(),
    });
  }

  for (const file of state.files) {
    await kuzuDb.upsertFile(conn, {
      fileId: file.file_id,
      repoId: artifact.repo_id,
      relPath: file.rel_path,
      contentHash: file.content_hash,
      language: file.language,
      byteSize: file.byte_size,
      lastIndexedAt: getCurrentTimestamp(),
    });
  }

  for (const symbol of state.symbols) {
    const { roleTagsJson, searchText } = resolveSymbolEnrichment({
      kind: symbol.kind,
      name: symbol.name,
      relPath: relPathByFileId.get(symbol.file_id) ?? "",
      summary: symbol.summary,
      signature: parseSignatureJson(symbol.signature_json),
      nativeRoleTagsJson: symbol.role_tags_json,
      nativeSearchText: symbol.search_text,
    });

    await kuzuDb.upsertSymbol(conn, {
      symbolId: symbol.symbol_id,
      repoId: artifact.repo_id,
      fileId: symbol.file_id,
      kind: symbol.kind,
      name: symbol.name,
      exported: Boolean(symbol.exported),
      visibility: symbol.visibility,
      language: symbol.language,
      rangeStartLine: symbol.range_start_line,
      rangeStartCol: symbol.range_start_col,
      rangeEndLine: symbol.range_end_line,
      rangeEndCol: symbol.range_end_col,
      astFingerprint: symbol.ast_fingerprint,
      signatureJson: symbol.signature_json,
      summary: symbol.summary,
      invariantsJson: symbol.invariants_json,
      sideEffectsJson: symbol.side_effects_json,
      roleTagsJson,
      searchText,
      updatedAt: symbol.updated_at,
    });
  }

  await kuzuDb.createVersion(conn, {
    versionId: state.version_id,
    repoId: state.repo_id,
    createdAt: getCurrentTimestamp(),
    reason: "Imported from sync artifact",
    prevVersionHash: state.prev_version_hash,
    versionHash: state.version_hash,
  });

  for (const sv of state.symbol_versions) {
    await kuzuDb.snapshotSymbolVersion(conn, {
      versionId: sv.version_id,
      symbolId: sv.symbol_id,
      astFingerprint: sv.ast_fingerprint,
      signatureJson: sv.signature_json,
      summary: sv.summary,
      invariantsJson: sv.invariants_json,
      sideEffectsJson: sv.side_effects_json,
    });
  }

  await kuzuDb.insertEdges(
    conn,
    state.edges.map((e) => ({
      repoId: e.repo_id,
      fromSymbolId: e.from_symbol_id,
      toSymbolId: e.to_symbol_id,
      edgeType: e.type,
      weight: e.weight,
      confidence: e.confidence,
      resolution: e.resolution,
      provenance: e.provenance,
      createdAt: e.created_at,
    })),
  );

  for (const metric of state.metrics) {
    await kuzuDb.upsertMetrics(conn, {
      symbolId: metric.symbol_id,
      fanIn: metric.fan_in,
      fanOut: metric.fan_out,
      churn30d: metric.churn_30d,
      testRefsJson: metric.test_refs_json,
      canonicalTestJson: metric.canonical_test_json,
      updatedAt: metric.updated_at,
    });
  }

  await kuzuDb.upsertSyncArtifact(conn, {
    artifactId: artifact.artifact_id,
    repoId: artifact.repo_id,
    versionId: artifact.version_id,
    commitSha: artifact.commit_sha,
    branch: artifact.branch,
    artifactHash: artifact.artifact_hash,
    compressedData: artifact.compressed_data,
    createdAt: artifact.created_at,
    sizeBytes: artifact.size_bytes,
  });

  const durationMs = Date.now() - startTime;

  return {
    repoId: artifact.repo_id,
    versionId: artifact.version_id,
    filesRestored: state.files.length,
    symbolsRestored: state.symbols.length,
    edgesRestored: state.edges.length,
    durationMs,
    verified: !options.verifyIntegrity || true,
  };
}

export function getArtifactMetadata(
  artifactPath: string,
): SyncArtifactMetadata | null {
  try {
    const artifactContent = readFileSync(artifactPath, "utf-8");
    const artifact: SyncArtifact = JSON.parse(artifactContent);

    const compressed = Buffer.from(artifact.compressed_data, "base64");
    const decompressed = gunzipSync(compressed);
    const state: SyncIndexState = JSON.parse(decompressed.toString("utf-8"));

    return {
      artifact_id: artifact.artifact_id,
      repo_id: artifact.repo_id,
      version_id: artifact.version_id,
      commit_sha: artifact.commit_sha,
      branch: artifact.branch,
      artifact_hash: artifact.artifact_hash,
      created_at: artifact.created_at,
      size_bytes: artifact.size_bytes,
      version_hash: state.version_hash,
      prev_version_hash: state.prev_version_hash,
      file_count: state.files.length,
      symbol_count: state.symbols.length,
      edge_count: state.edges.length,
    };
  } catch {
    return null;
  }
}

export async function listArtifacts(
  repoId: string,
  directory: string = join(process.cwd(), ".sdl-sync"),
): Promise<SyncArtifactMetadata[]> {
  try {
    const files = await readdir(directory);
    const artifacts: SyncArtifactMetadata[] = [];

    for (const file of files) {
      if (!file.endsWith(".sdl-artifact.json")) {
        continue;
      }
      const metadata = getArtifactMetadata(join(directory, file));
      if (metadata && metadata.repo_id === repoId) {
        artifacts.push(metadata);
      }
    }

    return artifacts.sort(
      (a, b) =>
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    );
  } catch {
    return [];
  }
}

function parseSignatureJson(signatureJson: string | null): {
  params?: Array<{ name?: string | null } | null> | null;
} | null {
  if (!signatureJson) {
    return null;
  }

  try {
    const parsed = JSON.parse(signatureJson);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

async function getGitCommitSha(repoPath: string): Promise<string | null> {
  try {
    const { execSync } = await import("child_process");
    const sha = execSync("git rev-parse HEAD", {
      cwd: repoPath,
      encoding: "utf-8",
    }).trim();
    return sha;
  } catch {
    return null;
  }
}

async function getGitBranch(repoPath: string): Promise<string | null> {
  try {
    const { execSync } = await import("child_process");
    const branch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: repoPath,
      encoding: "utf-8",
    }).trim();
    return branch;
  } catch {
    return null;
  }
}
