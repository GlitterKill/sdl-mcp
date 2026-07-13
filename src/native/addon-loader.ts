import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { logger } from "../util/logger.js";

type LoadCandidate = (candidate: string) => unknown;
type LogFailure = (failure: string) => void;
type NativeAddonCapability = (candidate: unknown) => boolean;

interface NativeAddonResolution {
  addon: unknown | null;
  path: string | null;
  failure: string | null;
}

interface NativeAddonLoaderTestOptions {
  loadCandidate?: LoadCandidate;
  logFailure?: LogFailure;
}

const require = createRequire(import.meta.url);
const nativeRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "native");
const defaultLoadCandidate: LoadCandidate = (candidate) => require(candidate) as unknown;
const defaultLogFailure: LogFailure = (failure) => {
  logger.debug("Native addon unavailable", { error: failure });
};
const acceptAnyAddon: NativeAddonCapability = () => true;

let loadCandidate = defaultLoadCandidate;
let logFailure = defaultLogFailure;
const resolutionCache = new Map<NativeAddonCapability, NativeAddonResolution>();
let sourcePath: string | null = null;
let loadFailure: string | null = null;

/** Return whether process-wide native addon loading is enabled. */
export function isNativeAddonGloballyEnabled(): boolean {
  return !/^(1|true)$/i.test(process.env.SDL_MCP_DISABLE_NATIVE_ADDON ?? "");
}

/** Locate and cache the first native addon with the requested capability. */
export function loadNativeAddon(
  isCompatible: NativeAddonCapability = acceptAnyAddon,
): unknown | null {
  if (!isNativeAddonGloballyEnabled()) {
    sourcePath = null;
    loadFailure = "disabled by SDL_MCP_DISABLE_NATIVE_ADDON";
    return null;
  }

  const cached = resolutionCache.get(isCompatible);
  if (cached) {
    sourcePath = cached.path;
    loadFailure = cached.failure;
    return cached.addon;
  }

  const overridePath = process.env.SDL_MCP_NATIVE_ADDON_PATH;
  const candidates = [
    ...(overridePath ? [overridePath] : []),
    join(nativeRoot, "sdl-mcp-native.node"),
    join(nativeRoot, "index.node"),
    "sdl-mcp-native",
  ];
  let lastFailure: string | null = null;
  let foundIncompatibleAddon = false;

  for (const candidate of candidates) {
    try {
      const loaded = loadCandidate(candidate);
      if (loaded !== null && loaded !== undefined && isCompatible(loaded)) {
        resolutionCache.set(isCompatible, {
          addon: loaded,
          path: candidate,
          failure: null,
        });
        sourcePath = candidate;
        loadFailure = null;
        return loaded;
      }
      if (loaded !== null && loaded !== undefined) {
        foundIncompatibleAddon = true;
        lastFailure = `Native addon candidate lacks required capabilities: ${candidate}`;
      } else {
        lastFailure = `Native addon candidate returned no value: ${candidate}`;
      }
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
    }
  }

  sourcePath = null;
  loadFailure = foundIncompatibleAddon ? "no compatible addon found" : "not found";
  resolutionCache.set(isCompatible, {
    addon: null,
    path: null,
    failure: loadFailure,
  });
  logFailure(lastFailure ?? loadFailure);
  return null;
}

/** Return the path or package name that loaded the cached addon. */
export function getNativeAddonSourcePath(): string | null {
  return sourcePath;
}

/** Return the cached load failure, if loading has been attempted. */
export function getNativeAddonLoadFailure(): string | null {
  return loadFailure;
}

/** Reset module state and optionally inject loader internals for unit tests. */
export function _resetNativeAddonLoaderForTests(
  options: NativeAddonLoaderTestOptions = {},
): void {
  loadCandidate = options.loadCandidate ?? defaultLoadCandidate;
  logFailure = options.logFailure ?? defaultLogFailure;
  resolutionCache.clear();
  sourcePath = null;
  loadFailure = null;
}
