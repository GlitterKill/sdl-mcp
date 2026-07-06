import { shortIdRegistry } from "../../short-id-registry.js";

export interface PackedShortIdOptions {
  sessionId?: string;
  shortIds?: boolean;
}

export type UsedShortIds = Map<string, string>;

export function packedShortIdsActive(options: PackedShortIdOptions = {}): boolean {
  return options.shortIds !== false && typeof options.sessionId === "string" && options.sessionId.length > 0;
}

export function aliasPackedSymbolId(
  symbolId: string,
  options: PackedShortIdOptions,
  used: UsedShortIds,
): string {
  if (!packedShortIdsActive(options)) return symbolId;
  const alias = shortIdRegistry.alias(options.sessionId as string, symbolId);
  if (alias !== symbolId) used.set(alias, symbolId);
  return alias;
}

/**
 * Appends the @ids dictionary line for every alias used in this payload that
 * has not yet been delivered in a packed payload. The packed candidate is
 * always encoded (to compare sizes at the gate) but may lose to JSON, so an
 * alias only counts as delivered once markShortIdsDelivered runs on a payload
 * that is actually attached to a response.
 */
export function appendIntroducedShortIds(
  payload: string,
  used: UsedShortIds,
  options: PackedShortIdOptions,
): string {
  if (!packedShortIdsActive(options) || used.size === 0) return payload;
  const sessionId = options.sessionId as string;
  const pending = [...used.entries()].filter(
    ([alias]) => !shortIdRegistry.isDelivered(sessionId, alias),
  );
  if (pending.length === 0) return payload;
  const idLine = `@ids=${pending
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

/** Marks the aliases introduced by a delivered packed payload as delivered. */
export function markShortIdsDelivered(
  packedPayload: string,
  options: PackedShortIdOptions,
): void {
  if (!packedShortIdsActive(options)) return;
  const aliases: string[] = [];
  for (const line of packedPayload.split("\n")) {
    if (!line.startsWith("@ids=")) continue;
    for (const entry of line.slice("@ids=".length).split(",")) {
      const alias = entry.split(":")[0];
      if (alias) aliases.push(alias);
    }
  }
  if (aliases.length > 0) {
    shortIdRegistry.markDelivered(options.sessionId as string, aliases);
  }
}
