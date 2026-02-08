import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { AppConfigSchema } from "./types.js";
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
function expandEnvVars(obj) {
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
        const result = {};
        for (const [key, value] of Object.entries(obj)) {
            result[key] = expandEnvVars(value);
        }
        return result;
    }
    return obj;
}
export function loadConfig(configPath) {
    // From src/config/, go up two levels to project root, then into config/
    const defaultConfigPath = resolve(__dirname, "../../config/sdlmcp.config.json");
    const filePath = configPath ? resolve(configPath) : defaultConfigPath;
    try {
        const rawContent = readFileSync(filePath, "utf-8");
        let parsedConfig;
        try {
            parsedConfig = JSON.parse(rawContent);
        }
        catch (err) {
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
    }
    catch (err) {
        if (err instanceof Error && "code" in err && err.code === "ENOENT") {
            throw new Error(`Config file not found: ${filePath}`);
        }
        throw err;
    }
}
//# sourceMappingURL=loadConfig.js.map