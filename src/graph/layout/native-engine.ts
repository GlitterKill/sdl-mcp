import {
  getNativeAddonLoadFailure,
  isNativeAddonGloballyEnabled,
  loadNativeAddon,
} from "../../native/addon-loader.js";

import type { LayoutInput, LayoutResult } from "./types.js";

interface NativeLayoutAddon {
  computeLayout(inputJson: string, seed: number, iterations: number): string;
}

let nativeAddon: NativeLayoutAddon | null | undefined;
let nativeReason = "not attempted";

function isCompatibleNativeLayoutAddon(addon: unknown): addon is NativeLayoutAddon {
  return !!addon && typeof addon === "object" && typeof (addon as Partial<NativeLayoutAddon>).computeLayout === "function";
}

function loadNativeLayoutAddon(): NativeLayoutAddon | null {
  if (!isNativeAddonGloballyEnabled()) {
    nativeReason = "disabled by SDL_MCP_DISABLE_NATIVE_ADDON";
    return null;
  }
  if (nativeAddon !== undefined) return nativeAddon;

  const loaded = loadNativeAddon(isCompatibleNativeLayoutAddon);
  if (isCompatibleNativeLayoutAddon(loaded)) {
    nativeAddon = loaded;
    nativeReason = "loaded";
    return nativeAddon;
  }

  nativeAddon = null;
  nativeReason =
    loaded === null
      ? (getNativeAddonLoadFailure() ?? "not found")
      : "incompatible addon";
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
