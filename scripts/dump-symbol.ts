import {
  handleSymbolGetCard,
  handleSymbolSearch,
} from "../src/mcp/tools/symbol.js";
import { resolveCliConfigPath } from "../src/config/configPath.js";
import { loadConfig } from "../src/config/loadConfig.js";
import type { SymbolCard } from "../src/mcp/types.js";
import { initGraphDb } from "../src/db/initGraphDb.js";
import { getKuzuConn } from "../src/db/kuzu.js";
import * as kuzuDb from "../src/db/kuzu-queries.js";

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
  const conn = await getKuzuConn();

  let card: SymbolCard | null = null;
  const isSymbolId = /[-_]/.test(query);

  if (isSymbolId) {
    const cardResponse = await handleSymbolGetCard({ symbolId: query });
    if ("card" in cardResponse) {
      card = cardResponse.card;
    } else {
      console.error("Symbol not modified, cannot dump");
      process.exit(1);
    }
  } else {
    const searchResponse = await handleSymbolSearch({
      repoId,
      query,
      limit: 1,
    });

    if (searchResponse.results.length === 0) {
      console.error(`No symbols found matching "${query}" in repo ${repoId}`);
      process.exit(1);
    }

    if (searchResponse.results.length > 1) {
      console.error(
        `Multiple symbols found matching "${query}". Please specify symbolId.`,
      );
      process.exit(1);
    }

    const cardResponse = await handleSymbolGetCard({
      symbolId: searchResponse.results[0].symbolId,
    });
    if ("card" in cardResponse) {
      card = cardResponse.card;
    } else {
      console.error("Symbol not modified, cannot dump");
      process.exit(1);
    }
  }

  if (!card) {
    console.error("Failed to retrieve symbol card");
    process.exit(1);
  }

  const edgesFrom = await kuzuDb.getEdgesFrom(conn, card.symbolId);
  const edgesToMap = await kuzuDb.getEdgesToSymbols(conn, [card.symbolId]);
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

