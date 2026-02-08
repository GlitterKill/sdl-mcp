import {
  handleSymbolGetCard,
  handleSymbolSearch,
} from "../src/mcp/tools/symbol.js";
import { loadConfig } from "../src/config/loadConfig.js";
import type { SymbolCard } from "../src/mcp/types.js";
import * as db from "../src/db/queries.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.error(
      "Usage: npx tsx scripts/dump-symbol.ts <repoId> <symbolId|name>",
    );
    process.exit(1);
  }

  const [repoId, query] = args;

  try {
    loadConfig();
  } catch (err) {
    console.error(
      "Failed to load config:",
      err instanceof Error ? err.message : err,
    );
    process.exit(1);
  }

  let card: SymbolCard | null = null;
  const isSymbolId = /[-_]/.test(query);

  if (isSymbolId) {
    try {
      const cardResponse = await handleSymbolGetCard({ symbolId: query });
      if ("card" in cardResponse) {
        card = cardResponse.card;
      } else {
        console.error("Symbol not modified, cannot dump");
        process.exit(1);
      }
    } catch (err) {
      console.error(
        "Error getting symbol by ID:",
        err instanceof Error ? err.message : err,
      );
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

    try {
      const cardResponse = await handleSymbolGetCard({
        symbolId: searchResponse.results[0].symbolId,
      });
      if ("card" in cardResponse) {
        card = cardResponse.card;
      } else {
        console.error("Symbol not modified, cannot dump");
        process.exit(1);
      }
    } catch (err) {
      console.error(
        "Error getting symbol card:",
        err instanceof Error ? err.message : err,
      );
      process.exit(1);
    }
  }

  if (!card) {
    console.error("Failed to retrieve symbol card");
    process.exit(1);
  }

  const edgesFrom = db.getEdgesFrom(card.symbolId);
  const edgesTo = db.getEdgesTo(card.symbolId);

  const edgesSummary = {
    outgoing: edgesFrom.map((e) => ({
      to: e.to_symbol_id,
      type: e.type,
      weight: e.weight,
    })),
    incoming: edgesTo.map((e) => ({
      from: e.from_symbol_id,
      type: e.type,
      weight: e.weight,
    })),
  };

  const output = {
    card,
    edges: edgesSummary,
    metrics: card.metrics,
  };

  console.log(JSON.stringify(output, null, 2));
  process.exit(0);
}

main().catch((err) => {
  console.error("Unexpected error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
