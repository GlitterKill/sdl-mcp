import * as crypto from "crypto";
import { mkdir, writeFile, readdir, rm, readFile, stat } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { promisify } from "util";
import { gzip } from "zlib";

import type { ArtifactManifest, ArtifactWriteResult } from "./types.js";
import { hashContent } from "../util/hashing.js";
import { logger } from "../util/logger.js";
import { ArtifactCleanupError } from "../domain/errors.js";
import type { RedactionConfig } from "../config/types.js";
import { isReDoSRisk } from "../util/safeRegex.js";

const gzipAsync = promisify(gzip);
const ARTIFACT_DIR_PREFIX = "sdl-runtime";

interface WriteArtifactOptions {
  repoId: string;
  runtime: string;
  argsHash: string;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  stdout: Buffer;
  stderr: Buffer;
  policyAuditHash: string;
  artifactTtlHours: number;
  maxArtifactBytes: number;
  artifactBaseDir?: string | null;
  redactionConfig?: RedactionConfig;
}

interface RedactionPattern {
  regex: RegExp;
  replacement: string;
}

const DEFAULT_REDACTION_PATTERNS: RedactionPattern[] = [
  {
    regex: /(?:AKIA|ASIA)[A-Z0-9]{16,32}/g,
    replacement: "[REDACTED:aws-key]",
  },
  {
    regex: /ghp_[A-Za-z0-9]{36}/g,
    replacement: "[REDACTED:github-token]",
  },
  {
    regex: /(?:password|secret|token|api[_-]?key)\s*[=:]\s*\S+/gi,
    replacement: "[REDACTED:secret]",
  },
];

export function generateArtifactId(repoId: string): string {
  return `runtime-${repoId}-${Date.now()}-${crypto.randomBytes(8).toString("hex")}`;
}

export function getArtifactBaseDir(configBaseDir?: string | null): string {
  if (configBaseDir && configBaseDir.trim().length > 0) {
    return configBaseDir;
  }
  return join(tmpdir(), ARTIFACT_DIR_PREFIX);
}

export function applyRedaction(
  content: string,
  redactionConfig?: RedactionConfig,
): string {
  if (!redactionConfig?.enabled) {
    return content;
  }

  let redacted = content;

  if (redactionConfig.includeDefaults) {
    for (const pattern of DEFAULT_REDACTION_PATTERNS) {
      redacted = redacted.replace(pattern.regex, pattern.replacement);
    }
  }

  for (const customPattern of redactionConfig.patterns) {
    if (isReDoSRisk(customPattern.pattern)) {
      logger.warn("Skipping redaction pattern with ReDoS risk", { pattern: customPattern.pattern });
      continue;
    }
    try {
      const flags = customPattern.flags ?? "g";
      const regex = new RegExp(customPattern.pattern, flags);
      const replacement = `[REDACTED:${customPattern.name ?? "custom"}]`;
      redacted = redacted.replace(regex, replacement);
    } catch (error) {
      logger.warn("Invalid runtime redaction regex; skipping pattern", {
        pattern: customPattern.pattern,
        flags: customPattern.flags,
        error,
      });
    }
  }

  return redacted;
}

export async function writeArtifact(
  opts: WriteArtifactOptions,
): Promise<ArtifactWriteResult> {
  const artifactId = generateArtifactId(opts.repoId);
  const artifactDir = join(
    getArtifactBaseDir(opts.artifactBaseDir),
    artifactId,
  );

  const totalOutputBytes = opts.stdout.length + opts.stderr.length;

  const redactedStdout = applyRedaction(
    opts.stdout.toString("utf-8"),
    opts.redactionConfig,
  );
  const redactedStderr = applyRedaction(
    opts.stderr.toString("utf-8"),
    opts.redactionConfig,
  );

  const stdoutSha256 = hashContent(redactedStdout);
  const stderrSha256 = hashContent(redactedStderr);

  const manifest: ArtifactManifest = {
    artifactId,
    repoId: opts.repoId,
    runtime: opts.runtime,
    argsHash: opts.argsHash,
    exitCode: opts.exitCode,
    signal: opts.signal,
    durationMs: opts.durationMs,
    stdoutBytes: opts.stdout.length,
    stderrBytes: opts.stderr.length,
    stdoutSha256,
    stderrSha256,
    policyAuditHash: opts.policyAuditHash,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(
      Date.now() + opts.artifactTtlHours * 3600_000,
    ).toISOString(),
  };

  if (totalOutputBytes > opts.maxArtifactBytes) {
    logger.warn(
      "Runtime artifact size exceeds maxArtifactBytes; skipping write",
      {
        artifactId,
        repoId: opts.repoId,
        totalOutputBytes,
        maxArtifactBytes: opts.maxArtifactBytes,
      },
    );
    return {
      artifactHandle: artifactId,
      artifactDir: "",
      manifest,
    };
  }

  try {
    const stdoutGzip = await gzipAsync(Buffer.from(redactedStdout, "utf-8"));
    const stderrGzip = await gzipAsync(Buffer.from(redactedStderr, "utf-8"));

    await mkdir(artifactDir, { recursive: true });
    await Promise.all([
      writeFile(join(artifactDir, "stdout.gz"), stdoutGzip),
      writeFile(join(artifactDir, "stderr.gz"), stderrGzip),
      writeFile(
        join(artifactDir, "manifest.json"),
        JSON.stringify(manifest, null, 2),
        "utf-8",
      ),
    ]);

    return {
      artifactHandle: artifactId,
      artifactDir,
      manifest,
    };
  } catch (error) {
    logger.error("Failed to persist runtime artifact", {
      artifactId,
      repoId: opts.repoId,
      artifactDir,
      error,
    });
    return {
      artifactHandle: artifactId,
      artifactDir: "",
      manifest,
    };
  }
}

export async function sweepExpiredArtifacts(
  baseDir?: string | null,
): Promise<{ deleted: number; errors: number }> {
  const artifactBaseDir = getArtifactBaseDir(baseDir);
  let deleted = 0;
  let errors = 0;

  let entries: string[];
  try {
    entries = await readdir(artifactBaseDir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { deleted, errors };
    }

    errors += 1;
    logger.error("Failed to list runtime artifact base directory", {
      artifactBaseDir,
      error: new ArtifactCleanupError(
        `Failed to read artifact base directory: ${artifactBaseDir}`,
      ),
      cause: error,
    });
    return { deleted, errors };
  }

  for (const entry of entries) {
    const artifactDir = join(artifactBaseDir, entry);
    const manifestPath = join(artifactDir, "manifest.json");

    try {
      const entryStats = await stat(artifactDir);
      if (!entryStats.isDirectory()) {
        continue;
      }

      const rawManifest = await readFile(manifestPath, "utf-8");
      const parsed = JSON.parse(rawManifest) as Partial<ArtifactManifest>;
      const expiresAtMs = new Date(parsed.expiresAt ?? "").getTime();

      if (!Number.isFinite(expiresAtMs)) {
        errors += 1;
        logger.warn("Runtime artifact manifest has invalid expiresAt", {
          artifactDir,
          manifestPath,
          expiresAt: parsed.expiresAt,
        });
        continue;
      }

      if (expiresAtMs < Date.now()) {
        await rm(artifactDir, { recursive: true, force: true });
        deleted += 1;
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        continue;
      }

      errors += 1;
      logger.error("Failed to sweep runtime artifact directory", {
        artifactDir,
        manifestPath,
        error: new ArtifactCleanupError(
          `Failed to sweep artifact directory: ${artifactDir}`,
        ),
        cause: error,
      });
    }
  }

  if (errors > 0) {
    logger.warn("Runtime artifact sweep completed with errors", {
      artifactBaseDir,
      deleted,
      errors,
    });
  }

  return { deleted, errors };
}

export async function readArtifactManifest(
  artifactHandle: string,
  baseDir?: string | null,
): Promise<ArtifactManifest | null> {
  const manifestPath = join(
    getArtifactBaseDir(baseDir),
    artifactHandle,
    "manifest.json",
  );

  try {
    const raw = await readFile(manifestPath, "utf-8");
    return JSON.parse(raw) as ArtifactManifest;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return null;
    }

    logger.error("Failed to read runtime artifact manifest", {
      artifactHandle,
      manifestPath,
      error,
    });
    throw error;
  }
}
