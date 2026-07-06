import { shortIdRegistry } from "../../short-id-registry.js";

export interface PackedShortIdOptions {
  sessionId?: string;
  shortIds?: boolean;
}

export type IntroducedShortIds = Map<string, string>;

export function packedShortIdsActive(options: PackedShortIdOptions = {}): boolean {
  return options.shortIds !== false && typeof options.sessionId === "string" && options.sessionId.length > 0;
}

export function aliasPackedSymbolId(
  symbolId: string,
  options: PackedShortIdOptions,
  introduced: IntroducedShortIds,
): string {
  if (!packedShortIdsActive(options)) return symbolId;
  const { alias, introduced: isIntroduced } = shortIdRegistry.aliasWithStatus(
    options.sessionId as string,
    symbolId,
  );
  if (isIntroduced) introduced.set(alias, symbolId);
  return alias;
}

export function appendIntroducedShortIds(
  payload: string,
  introduced: IntroducedShortIds,
): string {
  if (introduced.size === 0) return payload;
  const idLine = `@ids=${[...introduced.entries()]
    .map(([alias, symbolId]) => `${alias}:${symbolId}`)
    .join(",")}`;
  const lines = payload.split("\n");
  let insertAt = 1;
  while (insertAt < lines.length && lines[insertAt]?.startsWith("@")) {
    insertAt += 1;
  }
  lines.splice(insertAt, 0, idLine);
  return lines.join("\n");
}
