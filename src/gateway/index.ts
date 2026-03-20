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
import { createActionMap, routeGatewayCall, type ActionMap } from "./router.js";
import { registerLegacyTools } from "./legacy.js";
import {
  QUERY_ACTIONS,
  CODE_ACTIONS,
  REPO_ACTIONS,
  AGENT_ACTIONS,
} from "./schemas.js";
import { buildGatewayWireSchema } from "./thin-schemas.js";

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
  const queryWireSchema = buildGatewayWireSchema(QUERY_ACTIONS, actionMap);
  const codeWireSchema = buildGatewayWireSchema(CODE_ACTIONS, actionMap);
  const repoWireSchema = buildGatewayWireSchema(REPO_ACTIONS, actionMap);
  const agentWireSchema = buildGatewayWireSchema(AGENT_ACTIONS, actionMap);

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
    queryWireSchema,
    { title: "SDL Query" },
  );

  server.registerTool(
    "sdl.code",
    CODE_DESCRIPTION,
    CodeGatewaySchema,
    makeHandler(),
    codeWireSchema,
    { title: "SDL Code" },
  );

  server.registerTool(
    "sdl.repo",
    REPO_DESCRIPTION,
    RepoGatewaySchema,
    makeHandler(),
    repoWireSchema,
    { title: "SDL Repository" },
  );

  server.registerTool(
    "sdl.agent",
    AGENT_DESCRIPTION,
    AgentGatewaySchema,
    makeHandler(),
    agentWireSchema,
    { title: "SDL Agent" },
  );

  if (config.emitLegacyTools) {
    registerLegacyTools(server, services);
  }
}
