import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { MCPServer } from "../../server.js";

export async function setupStdioTransport(server: MCPServer): Promise<void> {
  const transport = new StdioServerTransport();
  await server.getServer().connect(transport);
}
