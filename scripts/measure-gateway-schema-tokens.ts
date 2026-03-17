/**
 * Token measurement script — compares flat vs gateway tool schema token counts.
 *
 * Usage: npx tsx scripts/measure-gateway-schema-tokens.ts
 */
import { createMCPServer } from "../src/server.js";
import { zodToJsonSchema } from "zod-to-json-schema";

function estimateTokens(charCount: number): number {
  // Rough GPT/Claude tokenizer approximation: ~4 chars per token
  return Math.ceil(charCount / 4);
}

function measure() {
  console.log("=== SDL-MCP Gateway Schema Token Measurement ===\n");

  // --- Flat mode (29 tools) ---
  const flatServer = createMCPServer();
  const flatTools = (flatServer as any).tools as Map<
    string,
    { name: string; description: string; inputSchema: any; wireSchema?: Record<string, unknown> }
  >;

  let flatTotalChars = 0;
  let flatToolCount = 0;
  for (const [_name, tool] of flatTools) {
    const schema = zodToJsonSchema(tool.inputSchema as any, {
      target: "openApi3",
    });
    const schemaStr = JSON.stringify(schema);
    const descStr = tool.description || "";
    flatTotalChars += schemaStr.length + descStr.length + tool.name.length;
    flatToolCount++;
  }

  // --- Gateway mode (4 tools) — uses wireSchema if present ---
  const gatewayServer = createMCPServer({
    gatewayConfig: { enabled: true, emitLegacyTools: false },
  });
  const gatewayTools = (gatewayServer as any).tools as Map<
    string,
    { name: string; description: string; inputSchema: any; wireSchema?: Record<string, unknown> }
  >;

  let gatewayTotalChars = 0;
  let gatewayToolCount = 0;
  for (const [_name, tool] of gatewayTools) {
    // Use wireSchema if present (this is what tools/list returns)
    const schema = tool.wireSchema
      ? tool.wireSchema
      : zodToJsonSchema(tool.inputSchema as any, { target: "openApi3" });
    const schemaStr = JSON.stringify(schema);
    const descStr = tool.description || "";
    gatewayTotalChars += schemaStr.length + descStr.length + tool.name.length;
    gatewayToolCount++;
  }

  // --- Gateway + Legacy mode ---
  const hybridServer = createMCPServer({
    gatewayConfig: { enabled: true, emitLegacyTools: true },
  });
  const hybridTools = (hybridServer as any).tools as Map<string, unknown>;
  const hybridToolCount = hybridTools.size;

  const flatTokens = estimateTokens(flatTotalChars);
  const gatewayTokens = estimateTokens(gatewayTotalChars);
  const ratio = ((gatewayTotalChars / flatTotalChars) * 100).toFixed(1);
  const savings = flatTokens - gatewayTokens;

  console.log(`Flat mode:    ${flatToolCount} tools, ~${flatTokens} tokens (${flatTotalChars} chars)`);
  console.log(`Gateway mode: ${gatewayToolCount} tools, ~${gatewayTokens} tokens (${gatewayTotalChars} chars)`);
  console.log(`Hybrid mode:  ${hybridToolCount} tools`);
  console.log(`\nGateway is ${ratio}% of flat mode`);
  console.log(`Estimated savings: ~${savings} tokens per tools/list call`);

  if (parseFloat(ratio) > 40) {
    console.log(
      `\n⚠️  WARNING: Gateway schema is ${ratio}% of flat (target: ≤40%)`,
    );
    console.log(
      "   Consider further optimization in compact-schema.ts / thin-schemas.ts",
    );
  } else {
    console.log(`\n✅ Gateway schema is within target (≤40% of flat)`);
  }
}

measure();
