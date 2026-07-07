export type SkinEffectPreset = "ripple" | "halo" | "twinkle" | "shockwave" | "none";
export type SkinManifest = {
  schemaVersion: 1;
  name: string;
  version: string;
  author?: string;
  colors?: Record<string, string>;
  background?: { skybox?: string; starfield?: boolean };
  nodes?: { byKind?: Record<string, { texture?: string; model?: string; scale?: number; color?: string }>; cluster?: { texture?: string; color?: string } };
  edges?: { byKind?: Record<string, { color?: string; style?: "solid" | "dashed" }> };
  effects?: Record<string, { preset?: SkinEffectPreset; speedMs?: number; color?: string; intensity?: number }>;
};

const PRESETS = new Set(["ripple", "halo", "twinkle", "shockwave", "none"]);

function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function stringField(record: Record<string, unknown>, key: string): string | null { return typeof record[key] === "string" ? record[key] as string : null; }

export function validateSkinManifest(value: unknown): { ok: true; manifest: SkinManifest; warnings: string[] } | { ok: false; errors: string[]; warnings: string[] } {
  const warnings: string[] = [];
  const errors: string[] = [];
  if (!isRecord(value)) return { ok: false, errors: ["manifest must be an object"], warnings };
  if (value.schemaVersion !== 1) errors.push("schemaVersion must be 1");
  const name = stringField(value, "name");
  const version = stringField(value, "version");
  if (!name) errors.push("name is required");
  if (!version) errors.push("version is required");
  for (const key of Object.keys(value)) if (!["schemaVersion", "name", "version", "author", "colors", "background", "nodes", "edges", "effects"].includes(key)) warnings.push("unknown field ignored: " + key);
  const effects = isRecord(value.effects) ? value.effects : undefined;
  if (effects) {
    for (const [name, effect] of Object.entries(effects)) {
      if (isRecord(effect) && typeof effect.preset === "string" && !PRESETS.has(effect.preset)) warnings.push("unknown effect preset ignored: " + name);
    }
  }
  if (errors.length > 0) return { ok: false, errors, warnings };
  return { ok: true, manifest: value as SkinManifest, warnings };
}
