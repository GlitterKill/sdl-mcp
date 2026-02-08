import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { AppConfig, AppConfigSchema } from "./types.js";
import { findPackageRoot } from "../util/findPackageRoot.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function expandEnvVars(obj: unknown): unknown {
  if (typeof obj === "string") {
    return obj.replace(/\$\{([^}]+)\}/g, (_, varName) => {
      const value = process.env[varName];
      if (value === undefined) {
        throw new Error(`Environment variable "${varName}" is not set`);
      }
      return value;
    });
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => expandEnvVars(item));
  }

  if (obj !== null && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      result[key] = expandEnvVars(value);
    }
    return result;
  }

  return obj;
}

export function loadConfig(configPath?: string): AppConfig {
  const packageRoot = findPackageRoot(__dirname);
  const defaultConfigPath = resolve(packageRoot, "config", "sdlmcp.config.json");
  const envConfigPath = process.env.SDL_CONFIG ?? process.env.SDL_CONFIG_PATH;
  const filePath = configPath
    ? resolve(configPath)
    : envConfigPath
      ? resolve(envConfigPath)
      : defaultConfigPath;

  try {
    const rawContent = readFileSync(filePath, "utf-8");
    let parsedConfig: unknown;

    try {
      parsedConfig = JSON.parse(rawContent);
    } catch (err) {
      if (err instanceof SyntaxError) {
        throw new Error(`Invalid JSON in config file: ${filePath}`);
      }
      throw err;
    }

    const expandedConfig = expandEnvVars(parsedConfig);

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

    return result.data;
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      throw new Error(`Config file not found: ${filePath}`);
    }
    throw err;
  }
}
