import type { MCPServer } from "../../server.js";
import { createMemoryHintHook } from "../hooks/memory-hint.js";
import { registerGatewayTools } from "../../gateway/index.js";
import { InfoRequestSchema, handleInfo } from "./info.js";
import type { ToolServices } from "../../gateway/index.js";
import { createActionMap } from "../../gateway/router.js";
import {
  registerActionSearchTool,
  registerCodeModeTools,
} from "../../code-mode/index.js";
import type { CodeModeConfig } from "../../config/types.js";
import {
  buildFlatToolDescriptors,
  registerFlatTools,
} from "./tool-descriptors.js";

export function registerTools(
  server: MCPServer,
  services: ToolServices = {},
  gatewayConfig?: { enabled?: boolean; emitLegacyTools?: boolean },
  codeModeConfig?: CodeModeConfig,
): void {
  // Register memory hint hook for all modes
  server.registerPostDispatchHook(createMemoryHintHook());

  // Universal discovery surface
  registerActionSearchTool(server, services);

  server.registerTool(
    "sdl.info",
    "Get unified SDL-MCP runtime, config, logging, Ladybug, and native-addon status.",
    InfoRequestSchema,
    handleInfo,
    undefined,
    { title: "SDL Info" },
  );

  // Code Mode exclusive: register action search plus code-mode tools only
  if (codeModeConfig?.enabled && codeModeConfig?.exclusive) {
    registerCodeModeTools(server, services, codeModeConfig);
    return;
  }

  if (gatewayConfig?.enabled) {
    server.gatewayMode = true;

    // When both gateway and code-mode are active, share one actionMap
    const sharedActionMap = codeModeConfig?.enabled
      ? createActionMap(services.liveIndex)
      : undefined;

    registerGatewayTools(
      server,
      services,
      {
        enabled: true,
        emitLegacyTools: gatewayConfig.emitLegacyTools ?? true,
      },
      sharedActionMap,
    );

    // Code Mode alongside gateway — reuse shared action map
    if (codeModeConfig?.enabled && sharedActionMap) {
      registerCodeModeTools(server, services, codeModeConfig, sharedActionMap);
    }
    return;
  }

  // Flat tool registration: declarative descriptors registered in a loop
  const descriptors = buildFlatToolDescriptors(services);
  registerFlatTools(server, descriptors);

  // Code Mode alongside flat tools
  if (codeModeConfig?.enabled) {
    registerCodeModeTools(server, services, codeModeConfig);
  }
}
