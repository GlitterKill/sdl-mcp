import type {
  SyncPullOptions,
  SyncPullResult,
  SyncArtifactMetadata,
} from "./types.js";
import { listArtifacts, getArtifactMetadata, importArtifact } from "./sync.js";
import { indexRepo, type IndexResult } from "../indexer/indexer.js";
import { getLatestVersion } from "../delta/versioning.js";
import { getRepo } from "../db/queries.js";
import { join } from "path";
import { sleep } from "../util/time.js";

const DEFAULT_MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

export async function pullLatestState(
  options: SyncPullOptions,
): Promise<SyncPullResult> {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  let retryCount = 0;
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const startTime = Date.now();
      const repo = getRepo(options.repoId);
      if (!repo) {
        throw new Error(`Repository not found: ${options.repoId}`);
      }

      const syncDir = join(process.cwd(), ".sdl-sync");
      const artifacts = await listArtifacts(options.repoId, syncDir);

      let targetArtifact: SyncArtifactMetadata | undefined;

      if (options.commitSha) {
        targetArtifact = artifacts.find(
          (a) => a.commit_sha === options.commitSha,
        );
      } else if (options.targetVersionId) {
        targetArtifact = artifacts.find(
          (a) => a.version_id === options.targetVersionId,
        );
      } else if (artifacts.length > 0) {
        targetArtifact = artifacts[0];
      }

      if (targetArtifact) {
        const artifactPath = join(
          syncDir,
          `${targetArtifact.artifact_id}.sdl-artifact.json`,
        );
        const metadata = getArtifactMetadata(artifactPath);

        if (!metadata) {
          throw new Error(`Failed to read artifact metadata: ${artifactPath}`);
        }

        const importResult = await importArtifact({
          artifactPath,
          repoId: options.repoId,
          verifyIntegrity: true,
        });

        const durationMs = Date.now() - startTime;

        return {
          success: true,
          versionId: importResult.versionId,
          artifactId: metadata.artifact_id,
          method: "artifact",
          durationMs,
          retryCount,
        };
      }

      if (options.fallbackToFullIndex ?? true) {
        const indexResult: IndexResult = await indexRepo(
          options.repoId,
          "full",
        );

        const latestVersion = getLatestVersion(options.repoId);
        const durationMs = Date.now() - startTime;

        return {
          success: true,
          versionId: indexResult.versionId,
          artifactId: null,
          method: "full-index",
          durationMs,
          retryCount,
        };
      }

      throw new Error(
        `No sync artifact found and fallback to full index disabled`,
      );
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      retryCount = attempt;

      if (attempt < maxRetries) {
        await sleep(RETRY_DELAY_MS * (attempt + 1));
      }
    }
  }

  return {
    success: false,
    versionId: null,
    artifactId: null,
    method: "fallback",
    durationMs: 0,
    retryCount,
    error: lastError?.message ?? "Unknown error",
  };
}

export async function pullWithFallback(
  options: SyncPullOptions,
): Promise<SyncPullResult> {
  const result = await pullLatestState(options);

  if (!result.success && (options.fallbackToFullIndex ?? true)) {
    try {
      const startTime = Date.now();
      const indexResult: IndexResult = await indexRepo(options.repoId, "full");

      const latestVersion = getLatestVersion(options.repoId);

      return {
        success: true,
        versionId: indexResult.versionId,
        artifactId: null,
        method: "full-index",
        durationMs: Date.now() - startTime + result.durationMs,
        retryCount: result.retryCount,
      };
    } catch (error) {
      return {
        success: false,
        versionId: null,
        artifactId: null,
        method: "fallback",
        durationMs: result.durationMs,
        retryCount: result.retryCount,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  return result;
}
