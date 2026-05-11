import type { SemanticEnrichmentConfig } from "../config/types.js";
import type { ActiveSemanticProviderType } from "./types.js";
import type { SemanticLanguagePack } from "./language-packs.js";

const PROVIDER_PRIORITY: readonly ActiveSemanticProviderType[] = ["scip", "lsp"];

export interface DetectedSemanticProvider {
  available: boolean;
  providerId?: string;
  providerVersion?: string;
  reason?: string;
  canAffectPass2?: boolean;
}

export type DetectedSemanticTools = Partial<
  Record<
    ActiveSemanticProviderType,
    Partial<Record<string, DetectedSemanticProvider>>
  >
>;

export interface SkippedSemanticProvider {
  providerType: ActiveSemanticProviderType;
  reason: string;
}

export interface SemanticSourceSelection {
  languageId: string;
  selected?: {
    providerType: ActiveSemanticProviderType;
    providerId: string;
    providerVersion?: string;
    canAffectPass2: boolean;
  };
  skipped: SkippedSemanticProvider[];
}

function providerEnabled(
  config: SemanticEnrichmentConfig | undefined,
  providerType: ActiveSemanticProviderType,
): boolean {
  const providerConfig = config?.providers?.[providerType];
  if (
    providerConfig &&
    typeof providerConfig === "object" &&
    "enabled" in providerConfig &&
    providerConfig.enabled === false
  ) {
    return false;
  }
  return true;
}

function configuredLanguages(
  config: SemanticEnrichmentConfig | undefined,
): Set<string> | null {
  const languages = config?.languages ?? [];
  return languages.length > 0 ? new Set(languages) : null;
}

export function selectSemanticSources(
  config: SemanticEnrichmentConfig | undefined,
  languagePacks: readonly SemanticLanguagePack[],
  detectedTools: DetectedSemanticTools,
): SemanticSourceSelection[] {
  const allowed = configuredLanguages(config);

  return languagePacks
    .filter((pack) => allowed === null || allowed.has(pack.languageId))
    .map((pack) => {
      const skipped: SkippedSemanticProvider[] = [];
      let selected: SemanticSourceSelection["selected"];

      for (const providerType of PROVIDER_PRIORITY) {
        if (!providerEnabled(config, providerType)) {
          skipped.push({ providerType, reason: "disabled by configuration" });
          continue;
        }
        const detected = detectedTools[providerType]?.[pack.languageId];
        if (!detected?.available) {
          skipped.push({
            providerType,
            reason: detected?.reason ?? "provider not available",
          });
          continue;
        }

        selected = {
          providerType,
          providerId: detected.providerId ?? providerType,
          providerVersion: detected.providerVersion,
          canAffectPass2: detected.canAffectPass2 === true,
        };
        break;
      }

      if (selected) {
        for (const providerType of PROVIDER_PRIORITY) {
          if (providerType === selected.providerType) break;
          if (!skipped.some((skip) => skip.providerType === providerType)) {
            skipped.push({
              providerType,
              reason: `lower priority than ${selected.providerType}`,
            });
          }
        }
        for (const providerType of PROVIDER_PRIORITY) {
          if (
            providerType !== selected.providerType &&
            !skipped.some((skip) => skip.providerType === providerType)
          ) {
            skipped.push({
              providerType,
              reason: `not selected; ${selected.providerType} has priority`,
            });
          }
        }
      }

      return { languageId: pack.languageId, selected, skipped };
    });
}
