/**
 * Gateway tool registration — registers 4 namespace-scoped gateway tools
 * and optionally keeps 29 legacy tool aliases for backward compatibility.
 */
import type { MCPServer, ToolContext } from "../server.js";
import type { LiveIndexCoordinator } from "../live-index/types.js";
import type { GatewayConfig } from "../config/types.js";
import {
  QueryGatewaySchema,
  CodeGatewaySchema,
  RepoGatewaySchema,
  AgentGatewaySchema,
} from "./schemas.js";
import {
  QUERY_DESCRIPTION,
  CODE_DESCRIPTION,
  REPO_DESCRIPTION,
  AGENT_DESCRIPTION,
} from "./descriptions.js";
import {
  QUERY_THIN_SCHEMA,
  CODE_THIN_SCHEMA,
  REPO_THIN_SCHEMA,
  AGENT_THIN_SCHEMA,
} from "./thin-schemas.js";
import { createActionMap, routeGatewayCall, type ActionMap } from "./router.js";
import { registerLegacyTools } from "./legacy.js";

export type ToolServices = {
  liveIndex?: LiveIndexCoordinator;
};

/**
 * Register gateway tools (4 namespace-scoped tools) on the server.
 * When emitLegacyTools is true, also registers the 29 original tool names.
 *
 * Each gateway tool gets:
 * - Full Zod schema (for runtime validation in the router)
 * - Thin wire schema (for tools/list — minimal JSON to save tokens)
 *
 * @param prebuiltActionMap Optional pre-built action map to avoid duplicate creation
 *   when code-mode is registered alongside gateway.
 */
export function registerGatewayTools(
  server: MCPServer,
  services: ToolServices,
  config: GatewayConfig,
  prebuiltActionMap?: ActionMap,
): void {
  const actionMap = prebuiltActionMap ?? createActionMap(services.liveIndex);

  const makeHandler = () => {
    return async (args: unknown, ctx?: ToolContext): Promise<unknown> => {
      return routeGatewayCall(args, actionMap, ctx);
    };
  };

  server.registerTool(
    "sdl.query",
    QUERY_DESCRIPTION,
    QueryGatewaySchema,
    makeHandler(),
    QUERY_THIN_SCHEMA,
  );

  server.registerTool(
    "sdl.code",
    CODE_DESCRIPTION,
    CodeGatewaySchema,
    makeHandler(),
    CODE_THIN_SCHEMA,
  );

  server.registerTool(
    "sdl.repo",
    REPO_DESCRIPTION,
    RepoGatewaySchema,
    makeHandler(),
    REPO_THIN_SCHEMA,
  );

  server.registerTool(
    "sdl.agent",
    AGENT_DESCRIPTION,
    AgentGatewaySchema,
    makeHandler(),
    AGENT_THIN_SCHEMA,
  );

  if (config.emitLegacyTools) {
    registerLegacyTools(server, services);
  }
}
