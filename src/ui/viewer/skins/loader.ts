import { unzipSync } from "fflate";
import { validateSkinManifest, type SkinManifest } from "./manifest-schema.js";

export type SkinCaps = { maxZipBytes: number; maxEntries: number; maxDecompressedBytes: number };
export type LoadedSkin = { manifest: SkinManifest; assets: Map<string, Uint8Array>; warnings: string[] };
const ALLOWED_ROOTS = new Set(["textures", "models"]);

export function validateSkinEntryPath(path: string): boolean {
  if (!path || path.startsWith("/") || /^[A-Za-z]:/.test(path) || path.includes("..")) return false;
  if (path === "skin.json") return true;
  const [root] = path.split("/");
  return ALLOWED_ROOTS.has(root ?? "");
}

export function loadSkinZip(bytes: Uint8Array, caps: SkinCaps): LoadedSkin {
  if (bytes.byteLength > caps.maxZipBytes) throw new Error("skin zip exceeds maxZipBytes");
  const files = unzipSync(bytes);
  const entries = Object.entries(files);
  if (entries.length > caps.maxEntries) throw new Error("skin zip exceeds maxEntries");
  let decompressed = 0;
  const assets = new Map<string, Uint8Array>();
  for (const [entryPath, data] of entries) {
    if (!validateSkinEntryPath(entryPath)) throw new Error("invalid skin entry path: " + entryPath);
    decompressed += data.byteLength;
    if (decompressed > caps.maxDecompressedBytes) throw new Error("skin zip exceeds maxDecompressedBytes");
    if (entryPath !== "skin.json") assets.set(entryPath, data);
  }
  const manifestBytes = files["skin.json"];
  if (!manifestBytes) throw new Error("skin.json is required");
  const json = new TextDecoder().decode(manifestBytes);
  const parsed = validateSkinManifest(JSON.parse(json));
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  return { manifest: parsed.manifest, assets, warnings: parsed.warnings };
}

export function applySkinCssVars(host: HTMLElement, manifest: SkinManifest): void {
  for (const [key, value] of Object.entries(manifest.colors ?? {})) {
    if (key.startsWith("--viewer-") || key.startsWith("--star-")) host.style.setProperty(key, value);
  }
}
