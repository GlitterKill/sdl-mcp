import { MCPServer } from "../../server.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

export async function setupStdioTransport(server: MCPServer): Promise<void> {
  const transport = new StdioServerTransport();
  await server.getServer().connect(transport);
}
