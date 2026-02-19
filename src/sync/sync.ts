import type {
  SyncArtifact,
  SyncArtifactMetadata,
  SyncExportOptions,
  SyncExportResult,
  SyncImportOptions,
  SyncImportResult,
  SyncIndexState,
} from "./types.js";
import { getDb } from "../db/db.js";
import type { SymbolVersionRow, MetricsRow } from "../db/schema.js";
import { hashContent } from "../util/hashing.js";
import { getCurrentTimestamp } from "../util/time.js";
import {
  getRepo,
  getFilesByRepo,
  getSymbolsByRepo,
  getEdgesByRepo,
  getVersion,
  getLatestVersion,
} from "../db/queries.js";
import { readdir, readFile, writeFile, mkdir } from "fs/promises";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { gzip, gunzip, gunzipSync } from "zlib";
import { promisify } from "util";

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

export async function exportArtifact(
  options: SyncExportOptions,
): Promise<SyncExportResult> {
  const startTime = Date.now();
  const db = getDb();

  const repo = getRepo(options.repoId);
  if (!repo) {
    throw new Error(`Repository not found: ${options.repoId}`);
  }

  const versionId =
    options.versionId ?? getLatestVersion(options.repoId)?.version_id;
  if (!versionId) {
    throw new Error(
      `No version found for repository: ${options.repoId}. Please index the repository first.`,
    );
  }

  const version = getVersion(versionId);
  if (!version) {
    throw new Error(`Version not found: ${versionId}`);
  }

  const commitSha =
    options.commitSha ?? (await getGitCommitSha(repo.root_path));

  const files = getFilesByRepo(options.repoId);
  const symbols = getSymbolsByRepo(options.repoId);

  const state: SyncIndexState = {
    repo_id: options.repoId,
    version_id: versionId,
    version_hash: version.version_hash,
    prev_version_hash: version.prev_version_hash,
    files: files.map((f) => ({
      file_id: f.file_id,
      rel_path: f.rel_path,
      content_hash: f.content_hash,
      language: f.language,
      byte_size: f.byte_size,
    })),
    symbols: symbols.map((s) => ({
      symbol_id: s.symbol_id,
      file_id: s.file_id,
      kind: s.kind,
      name: s.name,
      exported: s.exported,
      visibility: s.visibility,
      language: s.language,
      range_start_line: s.range_start_line,
      range_start_col: s.range_start_col,
      range_end_line: s.range_end_line,
      range_end_col: s.range_end_col,
      ast_fingerprint: s.ast_fingerprint,
      signature_json: s.signature_json,
      summary: s.summary,
      invariants_json: s.invariants_json,
      side_effects_json: s.side_effects_json,
      updated_at: s.updated_at,
    })),
    symbol_versions: db
      .prepare("SELECT * FROM symbol_versions WHERE version_id = ?")
      .all(versionId) as SymbolVersionRow[],
    edges: getEdgesByRepo(options.repoId),
    metrics: db
      .prepare(
        "SELECT * FROM metrics WHERE symbol_id IN (SELECT symbol_id FROM symbols WHERE repo_id = ?)",
      )
      .all(options.repoId) as MetricsRow[],
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
    branch: options.branch ?? (await getGitBranch(repo.root_path)),
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
  const db = getDb();

  const artifactContent = await readFile(options.artifactPath, "utf-8");
  const artifact: SyncArtifact = JSON.parse(artifactContent);

  if (options.repoId && artifact.repo_id !== options.repoId) {
    if (!options.force) {
      throw new Error(
        `Artifact repo_id (${artifact.repo_id}) does not match expected repo_id (${options.repoId}). Use --force to override.`,
      );
    }
  }

  if (options.verifyIntegrity) {
    const compressed = Buffer.from(artifact.compressed_data, "base64");
    const decompressed = await gunzipAsync(compressed);
    const state: SyncIndexState = JSON.parse(decompressed.toString("utf-8"));
    const computedHash = hashContent(JSON.stringify(state, null, 0));

    if (computedHash !== artifact.artifact_hash) {
      throw new Error("Artifact integrity check failed: hash mismatch");
    }
  }

  const compressed = Buffer.from(artifact.compressed_data, "base64");
  const decompressed = await gunzipAsync(compressed);
  const state: SyncIndexState = JSON.parse(decompressed.toString("utf-8"));

  const tx = db.transaction(() => {
    const existingRepo = db
      .prepare("SELECT repo_id FROM repos WHERE repo_id = ?")
      .get(artifact.repo_id) as { repo_id: string } | undefined;

    if (!existingRepo) {
      db.prepare(
        "INSERT INTO repos (repo_id, root_path, config_json, created_at) VALUES (?, ?, ?, ?)",
      ).run(state.repo_id, "", "{}", getCurrentTimestamp());
    }

    for (const file of state.files) {
      db.prepare(
        `INSERT OR REPLACE INTO files
           (file_id, repo_id, rel_path, content_hash, language, byte_size, last_indexed_at, directory)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        file.file_id,
        artifact.repo_id,
        file.rel_path,
        file.content_hash,
        file.language,
        file.byte_size,
        getCurrentTimestamp(),
        dirname(file.rel_path),
      );
    }

    for (const symbol of state.symbols) {
      db.prepare(
        `INSERT OR REPLACE INTO symbols
           (symbol_id, repo_id, file_id, kind, name, exported, visibility, language,
            range_start_line, range_start_col, range_end_line, range_end_col,
            ast_fingerprint, signature_json, summary, invariants_json, side_effects_json, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        symbol.symbol_id,
        artifact.repo_id,
        symbol.file_id,
        symbol.kind,
        symbol.name,
        symbol.exported,
        symbol.visibility,
        symbol.language,
        symbol.range_start_line,
        symbol.range_start_col,
        symbol.range_end_line,
        symbol.range_end_col,
        symbol.ast_fingerprint,
        symbol.signature_json,
        symbol.summary,
        symbol.invariants_json,
        symbol.side_effects_json,
        symbol.updated_at,
      );
    }

    for (const sv of state.symbol_versions) {
      db.prepare(
        `INSERT OR REPLACE INTO symbol_versions 
           (version_id, symbol_id, ast_fingerprint, signature_json, summary, invariants_json, side_effects_json)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        sv.version_id,
        sv.symbol_id,
        sv.ast_fingerprint,
        sv.signature_json,
        sv.summary,
        sv.invariants_json,
        sv.side_effects_json,
      );
    }

    db.prepare(
      `INSERT OR REPLACE INTO versions 
         (version_id, repo_id, created_at, reason, prev_version_hash, version_hash)
         VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      state.version_id,
      state.repo_id,
      getCurrentTimestamp(),
      "Imported from sync artifact",
      state.prev_version_hash,
      state.version_hash,
    );

    for (const edge of state.edges) {
      db.prepare(
        `INSERT INTO edges 
           (repo_id, from_symbol_id, to_symbol_id, type, weight, provenance, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        edge.repo_id,
        edge.from_symbol_id,
        edge.to_symbol_id,
        edge.type,
        edge.weight,
        edge.provenance,
        edge.created_at,
      );
    }

    for (const metric of state.metrics) {
      db.prepare(
        `INSERT OR REPLACE INTO metrics 
           (symbol_id, fan_in, fan_out, churn_30d, test_refs_json, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        metric.symbol_id,
        metric.fan_in,
        metric.fan_out,
        metric.churn_30d,
        metric.test_refs_json,
        metric.updated_at,
      );
    }
  });

  tx();

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
  } catch (error) {
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
      if (file.endsWith(".sdl-artifact.json")) {
        const metadata = getArtifactMetadata(join(directory, file));
        if (metadata && metadata.repo_id === repoId) {
          artifacts.push(metadata);
        }
      }
    }

    return artifacts.sort(
      (a, b) =>
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    );
  } catch (error) {
    return [];
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
  } catch (error) {
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
  } catch (error) {
    return null;
  }
}
