import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { LayoutInput, LayoutResult } from "./types.js";

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

interface NativeLayoutAddon {
  computeLayout(inputJson: string, seed: number, iterations: number): string;
}

let loadAttempted = false;
let nativeAddon: NativeLayoutAddon | null = null;
let nativeReason = "not attempted";

function isCompatibleNativeLayoutAddon(addon: unknown): addon is NativeLayoutAddon {
  return !!addon && typeof addon === "object" && typeof (addon as Partial<NativeLayoutAddon>).computeLayout === "function";
}

function loadNativeLayoutAddon(): NativeLayoutAddon | null {
  if (/^(1|true)$/i.test(process.env.SDL_MCP_DISABLE_NATIVE_ADDON ?? "")) {
    nativeReason = "disabled by SDL_MCP_DISABLE_NATIVE_ADDON";
    return null;
  }
  if (loadAttempted) return nativeAddon;
  loadAttempted = true;

  const overridePath = process.env.SDL_MCP_NATIVE_ADDON_PATH;
  const paths = [
    ...(overridePath ? [overridePath] : []),
    join(__dirname, "..", "..", "..", "native", "sdl-mcp-native.node"),
    join(__dirname, "..", "..", "..", "native", "index.node"),
    "sdl-mcp-native",
  ];

  for (const addonPath of paths) {
    try {
      const loaded = require(addonPath) as unknown;
      if (isCompatibleNativeLayoutAddon(loaded)) {
        nativeAddon = loaded;
        nativeReason = "loaded";
        return nativeAddon;
      }
    } catch {
      // Try the next addon candidate. The layout service falls back to TS in auto mode.
    }
  }

  nativeReason = "not found";
  return null;
}

export function isNativeLayoutEngineAvailable(): boolean {
  return loadNativeLayoutAddon() !== null;
}

export function getNativeLayoutEngineStatus(): { available: boolean; reason: string } {
  return { available: isNativeLayoutEngineAvailable(), reason: nativeReason };
}

export function computeNativeLayoutJson(input: LayoutInput, seed: number, iterations: number): string | null {
  const addon = loadNativeLayoutAddon();
  if (!addon) return null;
  return addon.computeLayout(JSON.stringify(input), seed, iterations);
}

export function computeNativeLayout(input: LayoutInput, seed: number, iterations: number): LayoutResult | null {
  const json = computeNativeLayoutJson(input, seed, iterations);
  return json ? (JSON.parse(json) as LayoutResult) : null;
}
