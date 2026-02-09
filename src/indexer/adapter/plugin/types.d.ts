import type { LanguageAdapter } from "../LanguageAdapter.js";
import { z } from "zod";
declare const PLUGIN_API_VERSION = "1.0.0";
export declare const PluginManifestSchema: z.ZodObject<{
    name: z.ZodString;
    version: z.ZodString;
    apiVersion: z.ZodString;
    description: z.ZodOptional<z.ZodString>;
    author: z.ZodOptional<z.ZodString>;
    license: z.ZodOptional<z.ZodString>;
    adapters: z.ZodArray<z.ZodObject<{
        extension: z.ZodString;
        languageId: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        extension: string;
        languageId: string;
    }, {
        extension: string;
        languageId: string;
    }>, "many">;
}, "strip", z.ZodTypeAny, {
    name: string;
    version: string;
    apiVersion: string;
    adapters: {
        extension: string;
        languageId: string;
    }[];
    description?: string | undefined;
    author?: string | undefined;
    license?: string | undefined;
}, {
    name: string;
    version: string;
    apiVersion: string;
    adapters: {
        extension: string;
        languageId: string;
    }[];
    description?: string | undefined;
    author?: string | undefined;
    license?: string | undefined;
}>;
export type PluginManifest = z.infer<typeof PluginManifestSchema>;
export interface PluginAdapter {
    extension: string;
    languageId: string;
    factory: () => LanguageAdapter;
}
export interface AdapterPlugin {
    manifest: PluginManifest;
    createAdapters(): Promise<PluginAdapter[]> | PluginAdapter[];
}
export interface PluginLoadResult {
    plugin: AdapterPlugin;
    loaded: boolean;
    errors: string[];
}
export interface PluginValidationResult {
    valid: boolean;
    errors: string[];
    warnings: string[];
}
export interface VersionRange {
    min?: string;
    max?: string;
}
export interface PluginLoadError {
    pluginPath: string;
    error: string;
    details?: unknown;
}
export declare function validateApiVersion(pluginVersion: string, hostVersion?: string): PluginValidationResult;
export declare function validateManifest(manifest: unknown): PluginValidationResult;
export { PLUGIN_API_VERSION };
