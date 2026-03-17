import { readFileSync, statSync } from "fs";
import { AppConfig, AppConfigSchema } from "./types.js";
import { resolveCliConfigPath } from "./configPath.js";

function expandEnvVars(obj: unknown, configPath: string): unknown {
  if (typeof obj === "string") {
    return obj.replace(/\$\{([^}]+)\}/g, (_, varName) => {
      const value = process.env[varName];
      if (value === undefined) {
        throw new Error(
          `Environment variable "${varName}" is not set (in config: ${configPath})`,
        );
      }
      return value;
    });
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => expandEnvVars(item, configPath));
  }

  if (obj !== null && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
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
    const rawContent = readFileSync(filePath, "utf-8");
    const normalizedContent = rawContent.replace(/^\uFEFF/, "");
    let parsedConfig: unknown;

    try {
      parsedConfig = JSON.parse(normalizedContent);
    } catch (err) {
      if (err instanceof SyntaxError) {
        throw new Error(`Invalid JSON in config file: ${filePath}`);
      }
      throw err;
    }

    const expandedConfig = expandEnvVars(parsedConfig, filePath);

    const result = AppConfigSchema.safeParse(expandedConfig);

    if (!result.success) {
      const errors = result.error.errors
        .map((e) => {
          const path = e.path.join(".");
          return `  - ${path}: ${e.message}`;
        })
        .join("\n");
      throw new Error(`Config validation failed:\n${errors}`);
    }

    const config = result.data;

    // Merge SDL_ALLOWED_REPO_ROOTS env var (comma-separated absolute paths)
    // into config.security.allowedRepoRoots at load time.
    const envAllowedRootsRaw = process.env.SDL_ALLOWED_REPO_ROOTS;
    if (envAllowedRootsRaw && envAllowedRootsRaw.trim().length > 0) {
      const envRoots = envAllowedRootsRaw
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      if (envRoots.length > 0) {
        if (!config.security) {
          config.security = { allowedRepoRoots: [] };
        }
        config.security.allowedRepoRoots = [
          ...config.security.allowedRepoRoots,
          ...envRoots,
        ];
      }
    }

    // Cache the result
    cachedConfig = config;
    cachedConfigPath = filePath;
    try {
      cachedConfigMtimeMs = statSync(filePath).mtimeMs;
    } catch {
      cachedConfigMtimeMs = null;
    }

    return config;
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      throw new Error(`Config file not found: ${filePath}`);
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
