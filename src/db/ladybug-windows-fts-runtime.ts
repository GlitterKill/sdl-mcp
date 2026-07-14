import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve, sep } from "node:path";


export interface PreloadedWindowsLibrary {
  token: number;
  loadedPath: string;
}

interface WindowsLibraryPreloaderAddon {
  preloadWindowsLibrary: (absolutePath: string) => PreloadedWindowsLibrary;
  releaseWindowsLibrary: (token: number) => void;
}

export type WindowsFtsRuntimeUnavailable = {
  status: "unavailable";
  reason:
    | "missing-package"
    | "invalid-package"
    | "native-loader-unavailable"
    | "preload-failed";
  recovery: string;
};

export interface WindowsFtsRuntimeOptions {
  platform?: string;
  arch?: string;
  packageName?: string;
  packageVersion?: string;
  requireResolve?: (specifier: string) => string;
  loadNativeAddon?: (isCompatible: (candidate: unknown) => boolean) => unknown | null | Promise<unknown | null>;
}

type VerifiedRuntimePackage = {
  binRoot: string;
  dllPaths: string[];
};

const require = createRequire(import.meta.url);
const runtimePackageName = "@sdl-mcp/ladybug-openssl-win32-x64";
const runtimePackageVersion = "3.5.7-sdl.1";
const expectedDlls = ["bin/libcrypto-3-x64.dll", "bin/libssl-3-x64.dll"] as const;
const verifiedRuntimePackageCache = new Map<string, VerifiedRuntimePackage>();

const recoveryByReason: Record<WindowsFtsRuntimeUnavailable["reason"], string> = {
  "missing-package":
    "Windows FTS requires @sdl-mcp/ladybug-openssl-win32-x64@3.5.7-sdl.1. Reinstall sdl-mcp with optional dependencies enabled.",
  "invalid-package":
    "The Windows FTS OpenSSL runtime package is incomplete or failed hash verification. Reinstall sdl-mcp and avoid copying DLLs from another OpenSSL distribution.",
  "native-loader-unavailable":
    "Windows FTS requires the current sdl-mcp-native package. Reinstall optional dependencies, update sdl-mcp-native, or unset SDL_MCP_DISABLE_NATIVE_ADDON.",
  "preload-failed":
    "SDL could not preload the verified Windows FTS OpenSSL runtime. Reinstall sdl-mcp optional dependencies and retry without mutating PATH.",
};

function unavailable(reason: WindowsFtsRuntimeUnavailable["reason"]): WindowsFtsRuntimeUnavailable {
  return { status: "unavailable", reason, recovery: recoveryByReason[reason] };
}

export function isWindowsFtsRuntimeUnavailable(
  value: unknown,
): value is WindowsFtsRuntimeUnavailable {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { status?: unknown }).status === "unavailable" &&
    typeof (value as { reason?: unknown }).reason === "string" &&
    typeof (value as { recovery?: unknown }).recovery === "string"
  );
}

function readJson(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, "utf8").replace(/^\uFEFF/u, ""));
}

function sha256(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function getRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function packageRootFromResolver(
  packageName: string,
  requireResolve: (specifier: string) => string,
): string | null {
  try {
    return dirname(requireResolve(packageName + "/package.json"));
  } catch {
    return null;
  }
}

function verifyRuntimePackage(options: WindowsFtsRuntimeOptions): VerifiedRuntimePackage | WindowsFtsRuntimeUnavailable {
  const packageName = options.packageName ?? runtimePackageName;
  const packageVersion = options.packageVersion ?? runtimePackageVersion;
  const requireResolve = options.requireResolve ?? require.resolve;
  const packageRoot = packageRootFromResolver(packageName, requireResolve);
  if (!packageRoot) return unavailable("missing-package");
  const cacheKey = `${packageName}@${packageVersion}:${resolve(packageRoot)}`;
  const cached = verifiedRuntimePackageCache.get(cacheKey);
  if (cached) return cached;

  try {
    const packageJson = getRecord(readJson(join(packageRoot, "package.json")));
    if (packageJson?.name !== packageName || packageJson.version !== packageVersion) {
      return unavailable("invalid-package");
    }

    const provenance = getRecord(readJson(join(packageRoot, "provenance.json")));
    const artifacts = getRecord(provenance?.artifacts);
    if (!artifacts) return unavailable("invalid-package");

    const dllPaths: string[] = [];
    for (const relativeDll of expectedDlls) {
      const artifact = getRecord(artifacts[relativeDll]);
      const expectedHash = artifact?.sha256;
      if (typeof expectedHash !== "string") return unavailable("invalid-package");
      const filePath = join(packageRoot, ...relativeDll.split("/"));
      if (!existsSync(filePath) || sha256(filePath) !== expectedHash) {
        return unavailable("invalid-package");
      }
      dllPaths.push(filePath);
    }

    const verified = { binRoot: join(packageRoot, "bin"), dllPaths };
    verifiedRuntimePackageCache.set(cacheKey, verified);
    return verified;
  } catch {
    return unavailable("invalid-package");
  }
}

function hasWindowsFtsRuntimeNativeCapability(candidate: unknown): candidate is WindowsLibraryPreloaderAddon {
  const addon = candidate as Partial<WindowsLibraryPreloaderAddon> | null;
  return (
    typeof addon?.preloadWindowsLibrary === "function" &&
    typeof addon.releaseWindowsLibrary === "function"
  );
}

function parsePreloadHandle(value: unknown): PreloadedWindowsLibrary {
  const handle = value as Partial<PreloadedWindowsLibrary> | null;
  if (
    typeof handle?.token !== "number" ||
    !Number.isSafeInteger(handle.token) ||
    handle.token <= 0 ||
    typeof handle.loadedPath !== "string"
  ) {
    throw new Error("native preload returned an invalid library handle");
  }
  return { token: handle.token, loadedPath: handle.loadedPath };
}

function pathStartsWith(childPath: string, parentPath: string): boolean {
  const child = resolve(childPath).toLowerCase();
  const parent = resolve(parentPath).toLowerCase();
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

function validateLoadedPath(handle: PreloadedWindowsLibrary, requestedPath: string, binRoot: string): void {
  const loadedPath = resolve(handle.loadedPath);
  if (basename(loadedPath).toLowerCase() !== basename(requestedPath).toLowerCase()) {
    throw new Error("native preload reported a different library name");
  }
  if (!pathStartsWith(loadedPath, binRoot)) {
    throw new Error("native preload reported a path outside the runtime package bin directory");
  }
}

async function loadDefaultNativeAddon(isCompatible: (candidate: unknown) => boolean): Promise<unknown | null> {
  const module = await import("../native/addon-loader.js");
  return module.loadNativeAddon(isCompatible);
}

function releaseHandles(addon: WindowsLibraryPreloaderAddon, handles: PreloadedWindowsLibrary[]): void {
  for (const handle of [...handles].reverse()) {
    addon.releaseWindowsLibrary(handle.token);
  }
}

export async function withWindowsFtsRuntime<T>(
  loadFts: () => Promise<T>,
  options: WindowsFtsRuntimeOptions = {},
): Promise<T | WindowsFtsRuntimeUnavailable> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  if (platform !== "win32" || arch !== "x64") {
    return await loadFts();
  }

  const runtimePackage = verifyRuntimePackage(options);
  if (isWindowsFtsRuntimeUnavailable(runtimePackage)) return runtimePackage;

  const loadAddon = options.loadNativeAddon ?? loadDefaultNativeAddon;
  const addon = await loadAddon(hasWindowsFtsRuntimeNativeCapability);
  if (!hasWindowsFtsRuntimeNativeCapability(addon)) {
    return unavailable("native-loader-unavailable");
  }

  const handles: PreloadedWindowsLibrary[] = [];
  try {
    for (const dllPath of runtimePackage.dllPaths) {
      // Acquire in dependency order: libcrypto first, then libssl.
      const handle = parsePreloadHandle(addon.preloadWindowsLibrary(dllPath));
      handles.push(handle);
      validateLoadedPath(handle, dllPath, runtimePackage.binRoot);
    }
  } catch {
    releaseHandles(addon, handles);
    return unavailable("preload-failed");
  }

  try {
    return await loadFts();
  } finally {
    // Keep dependency handles alive until Ladybug finishes loading FTS, then
    // release in reverse acquisition order to match normal loader ownership.
    releaseHandles(addon, handles);
  }
}
