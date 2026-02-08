import type { VersionId, RepoId } from "../db/schema.js";

export interface SyncArtifact {
  artifact_id: string;
  repo_id: RepoId;
  version_id: VersionId;
  commit_sha: string | null;
  branch: string | null;
  artifact_hash: string;
  compressed_data: string;
  created_at: string;
  size_bytes: number;
}

export interface SyncArtifactMetadata {
  artifact_id: string;
  repo_id: RepoId;
  version_id: VersionId;
  commit_sha: string | null;
  branch: string | null;
  artifact_hash: string;
  created_at: string;
  size_bytes: number;
  version_hash: string | null;
  prev_version_hash: string | null;
  file_count: number;
  symbol_count: number;
  edge_count: number;
}

export interface SyncExportOptions {
  repoId: RepoId;
  versionId?: VersionId;
  commitSha?: string;
  branch?: string;
  outputPath?: string;
  includeFullState?: boolean;
}

export interface SyncImportOptions {
  artifactPath: string;
  repoId?: RepoId;
  force?: boolean;
  verifyIntegrity?: boolean;
}

export interface SyncExportResult {
  artifactId: string;
  artifactPath: string;
  versionId: VersionId;
  commitSha: string | null;
  fileCount: number;
  symbolCount: number;
  edgeCount: number;
  sizeBytes: number;
  durationMs: number;
}

export interface SyncImportResult {
  repoId: RepoId;
  versionId: VersionId;
  filesRestored: number;
  symbolsRestored: number;
  edgesRestored: number;
  durationMs: number;
  verified: boolean;
}

export interface SyncPullOptions {
  repoId: RepoId;
  targetVersionId?: VersionId;
  commitSha?: string;
  fallbackToFullIndex?: boolean;
  maxRetries?: number;
}

export interface SyncPullResult {
  success: boolean;
  versionId: VersionId | null;
  artifactId: string | null;
  method: "artifact" | "full-index" | "fallback";
  durationMs: number;
  retryCount: number;
  error?: string;
}

export interface SyncIndexState {
  repo_id: RepoId;
  version_id: VersionId;
  version_hash: string | null;
  prev_version_hash: string | null;
  files: Array<{
    file_id: number;
    rel_path: string;
    content_hash: string;
    language: string;
    byte_size: number;
  }>;
  symbols: Array<{
    symbol_id: string;
    file_id: number;
    kind: string;
    name: string;
    exported: 0 | 1;
    visibility: string | null;
    language: string;
    range_start_line: number;
    range_start_col: number;
    range_end_line: number;
    range_end_col: number;
    ast_fingerprint: string;
    signature_json: string | null;
    summary: string | null;
    invariants_json: string | null;
    side_effects_json: string | null;
    updated_at: string;
  }>;
  symbol_versions: Array<{
    version_id: VersionId;
    symbol_id: string;
    ast_fingerprint: string;
    signature_json: string | null;
    summary: string | null;
    invariants_json: string | null;
    side_effects_json: string | null;
  }>;
  edges: Array<{
    repo_id: RepoId;
    from_symbol_id: string;
    to_symbol_id: string;
    type: "import" | "call" | "config";
    weight: number;
    provenance: string | null;
    created_at: string;
  }>;
  metrics: Array<{
    symbol_id: string;
    fan_in: number;
    fan_out: number;
    churn_30d: number;
    test_refs_json: string | null;
    updated_at: string;
  }>;
}
