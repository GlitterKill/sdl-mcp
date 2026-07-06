import {
  handleSymbolGetCard,
  handleSymbolSearch,
} from "../src/mcp/tools/symbol.js";
import { resolveCliConfigPath } from "../src/config/configPath.js";
import { loadConfig } from "../src/config/loadConfig.js";
import { initGraphDb } from "../src/db/initGraphDb.js";
import { getLadybugConn } from "../src/db/ladybug.js";
import * as ladybugDb from "../src/db/ladybug-queries.js";

type DumpSymbolCard = Record<string, unknown> & {
  symbolId: string;
  metrics?: unknown;
};

// The MCP handler returns a compact wire card, not the full domain SymbolCard.
function toDumpSymbolCard(card: unknown): DumpSymbolCard | null {
  if (typeof card !== "object" || card === null) return null;
  const record = card as Record<string, unknown>;
  return typeof record.symbolId === "string" ? (record as DumpSymbolCard) : null;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.error("Usage: npx tsx scripts/dump-symbol.ts <repoId> <symbolId|name>");
    process.exit(1);
  }

  const [repoId, query] = args;

  const configPath = resolveCliConfigPath(undefined, "read");
  const config = loadConfig(configPath);
  await initGraphDb(config, configPath);
  const conn = await getLadybugConn();

  let card: DumpSymbolCard | null = null;
  const isSymbolId = /[-_]/.test(query);

  if (isSymbolId) {
    const cardResponse = await handleSymbolGetCard({
      symbolId: query,
      refsMode: "off",
    });
    if ("card" in cardResponse) {
      card = toDumpSymbolCard(cardResponse.card);
    }
    if (!card) {
      console.error("Symbol response did not include a dumpable card");
      process.exit(1);
    }
  } else {
    const searchResponse = await handleSymbolSearch({
      repoId,
      query,
      limit: 1,
      wireFormat: "json",
    });

    const results = searchResponse.results;
    if (!Array.isArray(results)) {
      console.error("Symbol search returned packed results, cannot dump");
      process.exit(1);
    }

    if (results.length === 0) {
      console.error(`No symbols found matching "${query}" in repo ${repoId}`);
      process.exit(1);
    }

    if (results.length > 1) {
      console.error(
        `Multiple symbols found matching "${query}". Please specify symbolId.`,
      );
      process.exit(1);
    }

    const cardResponse = await handleSymbolGetCard({
      symbolId: results[0].symbolId,
      refsMode: "off",
    });
    if ("card" in cardResponse) {
      card = toDumpSymbolCard(cardResponse.card);
    }
    if (!card) {
      console.error("Symbol response did not include a dumpable card");
      process.exit(1);
    }
  }

  if (!card) {
    console.error("Failed to retrieve symbol card");
    process.exit(1);
  }

  const edgesFrom = await ladybugDb.getEdgesFrom(conn, card.symbolId);
  const edgesToMap = await ladybugDb.getEdgesToSymbols(conn, [card.symbolId]);
  const edgesTo = edgesToMap.get(card.symbolId) ?? [];

  const edgesSummary = {
    outgoing: edgesFrom.map((e) => ({
      to: e.toSymbolId,
      type: e.edgeType,
      weight: e.weight,
    })),
    incoming: edgesTo.map((e) => ({
      from: e.fromSymbolId,
      type: e.edgeType,
      weight: e.weight,
    })),
  };

  const output = {
    card,
    edges: edgesSummary,
    metrics: card.metrics,
  };

  console.log(JSON.stringify(output, null, 2));
}

main().catch((err) => {
  console.error("Unexpected error:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
