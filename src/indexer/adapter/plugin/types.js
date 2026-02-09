import { z } from "zod";
const PLUGIN_API_VERSION = "1.0.0";
export const PluginManifestSchema = z.object({
    name: z.string().min(1),
    version: z.string().min(1),
    apiVersion: z.string().min(1),
    description: z.string().optional(),
    author: z.string().optional(),
    license: z.string().optional(),
    adapters: z.array(z.object({
        extension: z.string().min(1),
        languageId: z.string().min(1),
    })),
});
export function validateApiVersion(pluginVersion, hostVersion = PLUGIN_API_VERSION) {
    const errors = [];
    const warnings = [];
    const [pluginMajor] = pluginVersion.split(".");
    const [hostMajor] = hostVersion.split(".");
    if (pluginMajor !== hostMajor) {
        errors.push(`Incompatible API version: plugin requires API ${pluginVersion}, host provides ${hostVersion}`);
    }
    return {
        valid: errors.length === 0,
        errors,
        warnings,
    };
}
export function validateManifest(manifest) {
    const result = PluginManifestSchema.safeParse(manifest);
    if (!result.success) {
        const errors = result.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`);
        return {
            valid: false,
            errors,
            warnings: [],
        };
    }
    const apiValidation = validateApiVersion(result.data.apiVersion);
    return {
        valid: apiValidation.valid,
        errors: apiValidation.errors,
        warnings: apiValidation.warnings,
    };
}
export { PLUGIN_API_VERSION };
//# sourceMappingURL=types.js.map