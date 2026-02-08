import { z } from "zod";

interface ToolDefinition {
  name: string;
  description?: string;
  inputSchema: z.ZodType;
}

interface ClientAssertionResult {
  clientName: string;
  toolDiscoveryPassed: boolean;
  schemaCompatibilityPassed: boolean;
  missingTools: string[];
  schemaErrors: string[];
}

export class ClientProfileAssertions {
  private expectedTools: ToolDefinition[] = [
    {
      name: "sdl.repo.register",
      description: "Register a new repository for indexing",
      inputSchema: z.object({
        repoId: z.string(),
        rootPath: z.string(),
        ignore: z.array(z.string()).optional(),
        languages: z.array(z.string()).optional(),
        maxFileBytes: z.number().optional(),
      }),
    },
    {
      name: "sdl.repo.status",
      description: "Get status information about a repository",
      inputSchema: z.object({
        repoId: z.string(),
      }),
    },
    {
      name: "sdl.index.refresh",
      description: "Refresh index for a repository (full or incremental)",
      inputSchema: z.object({
        repoId: z.string(),
        mode: z.enum(["full", "incremental"]),
        reason: z.string().optional(),
      }),
    },
    {
      name: "sdl.symbol.search",
      description: "Search for symbols by name or summary",
      inputSchema: z.object({
        repoId: z.string(),
        query: z.string(),
        limit: z.number().min(1).max(1000).optional(),
      }),
    },
    {
      name: "sdl.symbol.getCard",
      description: "Get a single symbol card by ID",
      inputSchema: z.object({
        repoId: z.string(),
        symbolId: z.string(),
      }),
    },
    {
      name: "sdl.slice.build",
      description: "Build a graph slice for a task context",
      inputSchema: z.object({
        repoId: z.string(),
        taskText: z.string(),
        stackTrace: z.string().optional(),
        failingTestPath: z.string().optional(),
        editedFiles: z.array(z.string()).optional(),
        entrySymbols: z.array(z.string()).optional(),
        budget: z
          .object({
            maxCards: z.number().optional(),
            maxEstimatedTokens: z.number().optional(),
          })
          .optional(),
      }),
    },
    {
      name: "sdl.slice.refresh",
      description: "Refresh an existing slice handle and return incremental delta",
      inputSchema: z.object({
        sliceHandle: z.string(),
        knownVersion: z.string(),
      }),
    },
    {
      name: "sdl.delta.get",
      description: "Get delta pack between two versions with blast radius",
      inputSchema: z.object({
        repoId: z.string(),
        fromVersion: z.string(),
        toVersion: z.string(),
      }),
    },
    {
      name: "sdl.code.needWindow",
      description:
        "Request access to raw code window for a symbol with gating policy",
      inputSchema: z.object({
        repoId: z.string(),
        symbolId: z.string(),
        reason: z.string(),
        expectedLines: z.number().min(1),
        identifiersToFind: z.array(z.string()),
        granularity: z.enum(["symbol", "block", "fileWindow"]).optional(),
        maxTokens: z.number().min(1).optional(),
        sliceContext: z
          .object({
            taskText: z.string(),
            stackTrace: z.string().optional(),
            failingTestPath: z.string().optional(),
            editedFiles: z.array(z.string()).optional(),
            entrySymbols: z.array(z.string()).optional(),
            budget: z
              .object({
                maxCards: z.number().optional(),
                maxEstimatedTokens: z.number().optional(),
              })
              .optional(),
          })
          .optional(),
      }),
    },
    {
      name: "sdl.code.getSkeleton",
      description:
        "Get skeleton view of code (signatures + control flow + elided bodies)",
      inputSchema: z
        .object({
          repoId: z.string(),
          symbolId: z.string().optional(),
          file: z.string().optional(),
          exportedOnly: z.boolean().optional(),
          maxLines: z.number().min(1).optional(),
          maxTokens: z.number().min(1).optional(),
          identifiersToFind: z.array(z.string()).optional(),
        })
        .refine(
          (data) => data.symbolId !== undefined || data.file !== undefined,
          {
            message: "Either symbolId or file must be provided",
          },
        ),
    },
    {
      name: "sdl.policy.get",
      description: "Get policy configuration for a repository",
      inputSchema: z.object({
        repoId: z.string(),
      }),
    },
    {
      name: "sdl.policy.set",
      description: "Update policy configuration for a repository",
      inputSchema: z.object({
        repoId: z.string(),
        policyPatch: z
          .object({
            maxWindowLines: z.number().optional(),
            maxWindowTokens: z.number().optional(),
            requireIdentifiers: z.boolean().optional(),
            allowBreakGlass: z.boolean().optional(),
          })
          .optional(),
      }),
    },
  ];

  assertToolDiscovery(actualTools: unknown): ClientAssertionResult {
    const result: ClientAssertionResult = {
      clientName: "generic",
      toolDiscoveryPassed: true,
      schemaCompatibilityPassed: true,
      missingTools: [],
      schemaErrors: [],
    };

    const tools = actualTools as { tools?: unknown[] };
    const actualToolList = tools.tools || [];

    for (const expectedTool of this.expectedTools) {
      const found = actualToolList.find(
        (t) =>
          typeof t === "object" &&
          t !== null &&
          (t as { name: string }).name === expectedTool.name,
      );

      if (!found) {
        result.missingTools.push(expectedTool.name);
        result.toolDiscoveryPassed = false;
      }
    }

    return result;
  }

  assertSchemaCompatibility(actualTools: unknown): ClientAssertionResult {
    const result: ClientAssertionResult = {
      clientName: "generic",
      toolDiscoveryPassed: true,
      schemaCompatibilityPassed: true,
      missingTools: [],
      schemaErrors: [],
    };

    const tools = actualTools as { tools?: unknown[] };
    const actualToolList = tools.tools || [];

    for (const actualTool of actualToolList) {
      if (typeof actualTool !== "object" || actualTool === null) {
        continue;
      }

      const toolName = (actualTool as { name: string }).name;
      const inputSchema = (actualTool as { inputSchema?: unknown }).inputSchema;

      const expectedTool = this.expectedTools.find((t) => t.name === toolName);
      if (!expectedTool) {
        continue;
      }

      try {
        if (inputSchema) {
          const schema = inputSchema as Record<string, unknown>;
          if (!schema.type || schema.type !== "object") {
            result.schemaErrors.push(
              `${toolName}: inputSchema type must be "object"`,
            );
            result.schemaCompatibilityPassed = false;
          }
          if (!schema.properties || typeof schema.properties !== "object") {
            result.schemaErrors.push(
              `${toolName}: inputSchema missing properties`,
            );
            result.schemaCompatibilityPassed = false;
          }
        }
      } catch (error) {
        result.schemaErrors.push(
          `${toolName}: Schema validation error - ${error instanceof Error ? error.message : String(error)}`,
        );
        result.schemaCompatibilityPassed = false;
      }
    }

    return result;
  }

  assertClientProfile(
    clientName: string,
    actualTools: unknown,
    clientCapabilities?: string[],
  ): ClientAssertionResult {
    const toolDiscoveryResult = this.assertToolDiscovery(actualTools);
    const schemaResult = this.assertSchemaCompatibility(actualTools);

    return {
      clientName,
      toolDiscoveryPassed: toolDiscoveryResult.toolDiscoveryPassed,
      schemaCompatibilityPassed: schemaResult.schemaCompatibilityPassed,
      missingTools: toolDiscoveryResult.missingTools,
      schemaErrors: schemaResult.schemaErrors,
    };
  }

  getClientSpecificRequirements(clientName: string): string[] {
    const requirements: Record<string, string[]> = {
      "claude-code": [
        "stdio transport",
        "tool discovery",
        "resource support (optional)",
        "truncation annotations",
      ],
      codex: ["stdio transport", "tool discovery", "truncation annotations"],
      gemini: ["stdio transport", "tool discovery", "truncation annotations"],
      opencode: ["stdio transport", "tool discovery", "truncation annotations"],
    };

    return requirements[clientName] || ["stdio transport", "tool discovery"];
  }

  getExpectedToolNames(): string[] {
    return this.expectedTools.map((t) => t.name);
  }
}

export const clientAssertions = new ClientProfileAssertions();
