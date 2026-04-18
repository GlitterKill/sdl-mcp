import { readFileSync, statSync } from "fs";
import {
  AppConfig,
  AppConfigSchema,
  IndexingConfigSchema,
  LiveIndexConfigSchema,
  ConcurrencyConfigSchema,
  ParallelScorerConfigSchema,
  RuntimeConfigSchema,
  SemanticConfigSchema,
} from "./types.js";
import { ConfigError } from "../domain/errors.js";
import { resolveCliConfigPath } from "./configPath.js";
import { normalizePath } from "../util/paths.js";
import { detectCpuProfile } from "../util/cpu-detect.js";
import { resolvePerformancePresets } from "../util/cpu-presets.js";

function expandEnvVars(obj: unknown, configPath: string): unknown {
  if (typeof obj === "string") {
    return obj.replace(/\$\{([^}]+)\}/g, (_, captured: string) => {
      // Support ${VAR:-default} syntax
      const sepIdx = captured.indexOf(":-");
      const varName = sepIdx >= 0 ? captured.slice(0, sepIdx) : captured;
      const defaultValue = sepIdx >= 0 ? captured.slice(sepIdx + 2) : undefined;

      const value = process.env[varName];
      if (value !== undefined) {
        return value;
      }
      if (defaultValue !== undefined) {
        return defaultValue;
      }
      throw new ConfigError(
        `Environment variable "${varName}" is not set (in config: ${configPath})`,
      );
    });
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => expandEnvVars(item, configPath));
  }

  if (obj !== null && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") {
        continue;
      }
      result[key] = expandEnvVars(value, configPath);
    }
    return result;
  }

  return obj;
}

let cachedConfig: AppConfig | null = null;
let cachedConfigPath: string | null = null;
let cachedConfigMtimeMs: number | null = null;

export function loadConfig(configPath?: string): AppConfig {
  const filePath = resolveCliConfigPath(configPath, "read");

  // Return cached config if file hasn't changed
  if (cachedConfig && cachedConfigPath === filePath) {
    try {
      const currentMtime = statSync(filePath).mtimeMs;
      if (currentMtime === cachedConfigMtimeMs) {
        return cachedConfig;
      }
    } catch {
      // If stat fails, fall through to re-read
    }
  }

  try {
    // Read mtime BEFORE file content to avoid TOCTOU race:
    // if the file changes between read and stat, we get an older mtime,
    // so the next call will detect the change and re-read.
    let mtimeBeforeRead: number | null = null;
    try {
      mtimeBeforeRead = statSync(filePath).mtimeMs;
    } catch {
      // stat may fail; will fall through with null mtime
    }

    const rawContent = readFileSync(filePath, "utf-8");
    const normalizedContent = rawContent.replace(/^\uFEFF/, "");
    let parsedConfig: unknown;

    try {
      parsedConfig = JSON.parse(normalizedContent);
    } catch (err) {
      if (err instanceof SyntaxError) {
        throw new ConfigError(`Invalid JSON in config file: ${filePath}`);
      }
      throw err;
    }

    const expandedConfig = expandEnvVars(parsedConfig, filePath);

    const result = AppConfigSchema.safeParse(expandedConfig);

    if (!result.success) {
      const errors = result.error.issues
        .map((e) => {
          const path = e.path.join(".");
          return `  - ${path}: ${e.message}`;
        })
        .join("\n");
      throw new ConfigError(`Config validation failed:\n${errors}`);
    }

    const config = result.data;

    // -------------------------------------------------------------------------
    // CPU tier preset resolution
    // -------------------------------------------------------------------------
    // Pass the raw (pre-Zod) config object so that resolvePerformancePresets
    // can distinguish user-explicit values from Zod-filled defaults.
    // Only apply when performanceTier is "auto" (the default).
    const rawConfig = expandedConfig as Record<string, unknown>;
    let tierAdjustedConfig = config;
    if (config.performanceTier === "auto") {
      const cpuProfile = detectCpuProfile();
      const tier = cpuProfile.detectedTier;
      const presets = resolvePerformancePresets(
        tier,
        rawConfig as Parameters<typeof resolvePerformancePresets>[1],
      );
      // Re-parse each sub-section through its schema so that Zod fills in any
      // missing required fields before we overlay the preset values.
      const baseIndexing = IndexingConfigSchema.parse(config.indexing ?? {});
      const baseConcurrency = ConcurrencyConfigSchema.parse(
        config.concurrency ?? {},
      );
      const baseLiveIndex = LiveIndexConfigSchema.parse(config.liveIndex ?? {});
      const baseParallelScorer = ParallelScorerConfigSchema.parse(
        config.parallelScorer ?? {},
      );

      tierAdjustedConfig = {
        ...config,
        indexing: { ...baseIndexing, concurrency: presets.indexingConcurrency },
        concurrency: {
          ...baseConcurrency,
          maxToolConcurrency: presets.maxToolConcurrency,
          readPoolSize: presets.readPoolSize,
          writePoolSize: presets.writePoolSize,
          maxSessions: presets.maxSessions,
        },
        runtime: (() => {
          const baseRuntime = RuntimeConfigSchema.parse(config.runtime ?? {});
          return {
            ...baseRuntime,
            maxConcurrentJobs: presets.runtimeMaxConcurrentJobs,
          };
        })(),
        liveIndex: {
          ...baseLiveIndex,
          reconcileConcurrency: presets.reconcileConcurrency,
        },
        semantic: (() => {
          const baseSemantic = SemanticConfigSchema.parse(
            config.semantic ?? {},
          );
          return {
            ...baseSemantic,
            summaryMaxConcurrency: presets.summaryMaxConcurrency,
          };
        })(),
        parallelScorer: {
          ...baseParallelScorer,
          enabled: presets.parallelScorerEnabled,
          poolSize: presets.parallelScorerPoolSize,
        },
      };
    }

    // Merge SDL_ALLOWED_REPO_ROOTS env var (comma-separated absolute paths)
    // into config.security.allowedRepoRoots at load time.
    // Build a new object instead of mutating the Zod-parsed result.
    const envAllowedRootsRaw = process.env.SDL_ALLOWED_REPO_ROOTS;
    let finalConfig = tierAdjustedConfig;
    if (envAllowedRootsRaw && envAllowedRootsRaw.trim().length > 0) {
      const envRoots = envAllowedRootsRaw
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      if (envRoots.length > 0) {
        const mergedSecurity = {
          ...(finalConfig.security ?? { allowedRepoRoots: [] }),
          allowedRepoRoots: [
            ...(finalConfig.security?.allowedRepoRoots ?? []),
            ...envRoots,
          ],
        };
        finalConfig = { ...finalConfig, security: mergedSecurity };
      }
    }

    // scip-io integration: when the generator is enabled (and SCIP ingest is
    // also enabled), ensure the produced index.scip is in scip.indexes so the
    // existing post-refresh auto-ingest picks it up. Users only need
    // `scip.generator.enabled = true` to opt in — they don't have to also
    // remember to add `{ "path": "index.scip" }` to scip.indexes.
    if (finalConfig.scip?.enabled && finalConfig.scip?.generator?.enabled) {
      const hasIndexEntry = finalConfig.scip.indexes.some(
        (e) => normalizePath(e.path) === "index.scip",
      );
      if (!hasIndexEntry) {
        finalConfig = {
          ...finalConfig,
          scip: {
            ...finalConfig.scip,
            indexes: [
              ...finalConfig.scip.indexes,
              { path: "index.scip", label: "scip-io" },
            ],
          },
        };
      }
    }

    // Cache the result (use mtime captured before read to avoid TOCTOU)
    cachedConfig = finalConfig;
    cachedConfigPath = filePath;
    cachedConfigMtimeMs = mtimeBeforeRead;

    return finalConfig;
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      throw new ConfigError(`Config file not found: ${filePath}`);
    }
    throw err;
  }
}

/** Invalidate the cached config, forcing the next loadConfig() call to re-read from disk. */
export function invalidateConfigCache(): void {
  cachedConfig = null;
  cachedConfigPath = null;
  cachedConfigMtimeMs = null;
}
