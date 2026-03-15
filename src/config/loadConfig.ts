import { readFileSync } from "fs";
import { AppConfig, AppConfigSchema } from "./types.js";
import { resolveCliConfigPath } from "./configPath.js";

function expandEnvVars(obj: unknown, configPath: string): unknown {
  if (typeof obj === "string") {
    return obj.replace(/\$\{([^}]+)\}/g, (_, varName) => {
      const value = process.env[varName];
      if (value === undefined) {
        throw new Error(`Environment variable "${varName}" is not set (in config: ${configPath})`);
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

export function loadConfig(configPath?: string): AppConfig {
  const filePath = resolveCliConfigPath(configPath, "read");

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

    return result.data;
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      throw new Error(`Config file not found: ${filePath}`);
    }
    throw err;
  }
}
