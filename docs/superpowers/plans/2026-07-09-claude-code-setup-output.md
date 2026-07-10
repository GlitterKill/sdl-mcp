# Claude Code Setup Output Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `sdl-mcp init` emit valid, shell-safe Claude Code MCP setup instructions for project, local, and user scopes without changing the full-document shape of generated client configuration files.

**Architecture:** Keep template loading and `generateClientConfig` format-agnostic. Add one pure Claude-specific renderer beside `emitClientConfigBlocks` that validates `mcpServers.sdl-mcp` with `ConfigError`, derives the project wrapper and compact CLI payload from the same generated server object, and renders platform-specific shell instructions; `emitClientConfigBlocks` only selects that renderer and suppresses the obsolete detected-settings path as a destination.

**Tech Stack:** TypeScript, Node.js built-in `node:test` and `node:assert`, ESM imports with `.js` extensions, JSON templates, PowerShell and POSIX shell quoting.

---

## Chunk 1: Claude Code Setup Output

Use `@test-driven-development` for Tasks 1-3 and `@verification-before-completion` for Task 4. Keep each red-green cycle scoped to this track.

### Scope and locked decisions

- The authoritative requirements are `docs/superpowers/specs/2026-07-09-backlog-resolution-design.md`, section 1, plus its shared compatibility, test, and completion gates.
- `generateClientConfig` remains the single format-agnostic path that normalizes and injects `SDL_CONFIG`. Do not duplicate that injection in the Claude renderer.
- The project block and both `claude mcp add-json` commands must use the same generated `mcpServers["sdl-mcp"]` object. The only shape difference is the required outer `mcpServers` wrapper for project scope.
- `detectInstalledClients` may continue using `.claude/settings.json` to detect Claude Code. That detected path is not a valid MCP configuration destination and must not be printed beside the Claude setup block.
- `process.platform === "win32"` selects PowerShell output. Every other Node platform selects POSIX shell output. Tests pass the platform explicitly so output is deterministic on both CI operating systems. Current `claude mcp add-json --help` confirms `Usage: claude mcp add-json [options] <name> <json>` and scopes `local`, `user`, and `project`; this track emits the approved direct project file plus explicit local/user CLI forms.
- Do not emit an inline `cmd.exe` JSON command. The Windows output names PowerShell and directs `cmd.exe` users to the project `.mcp.json` form or the PowerShell snippet.
- Do not change other client rendering, client detection order, generated asset naming, or the generic template loader.

### Current evidence and focused symbols

| Path / symbol | Current responsibility | Planned responsibility |
| --- | --- | --- |
| `src/cli/commands/init.ts:596-610` — `loadClientTemplateSync` | Loads and parses `templates/<client>.json` as `unknown`. | Reuse unchanged. JSON parse/path failures still occur before rendering. |
| `src/cli/commands/init.ts:612-614` — `loadClientTemplate` | Async wrapper around the sync loader. | Reuse unchanged. |
| `src/cli/commands/init.ts:1841-1862` — `generateClientConfig` | Preserves the template document and injects normalized `SDL_CONFIG` into the `sdl-mcp` server environment. | Reuse unchanged so generated files and emitted instructions share one server object. |
| `src/cli/commands/init.ts:1882-1886` — `ClientDetection` | Carries detected client name, detected path, and optional template client. | Reuse unchanged. |
| `src/cli/commands/init.ts:1906-2129` — `detectInstalledClients` | Detects Claude Code, including `CLAUDE_CONFIG_DIR` handling. | Reuse unchanged; its path remains detection evidence only. |
| `src/cli/commands/init.ts:2131-2148` — `emitClientConfigBlocks` | Prints every detected path and a full generated JSON document. | Select the Claude renderer and omit the obsolete Claude settings path from the output label. |
| `src/domain/errors.ts:18-24` — `ConfigError` | Existing typed configuration failure. | Reuse for a missing or malformed `mcpServers.sdl-mcp` entry. |
| `tests/unit/init-claude-config-dir.test.ts` — `describe("detectInstalledClients — CLAUDE_CONFIG_DIR (issue #17)")` | Proves Claude detection and environment handling. | Reference its environment isolation style; do not modify it. |
| `templates/claude-code.json` | Documents stale placement/quoting guidance and an old server command shape. | Document project vs. CLI destinations and carry the canonical stdio server object. |
| `BACKLOG.md:13-16` | Ignored local queue entry for this defect. | Mark only this item complete after every focused and shared gate passes. |

Slice evidence: `emitClientConfigBlocks` calls `detectInstalledClients`, `loadClientTemplate`, `generateClientConfig`, and `buildGenericClientConfig`. `buildUndetectedClientConfigAssets` at `src/cli/commands/init.ts:417-433` also calls `generateClientConfig(loadClientTemplateSync(...))`; it must retain a full `mcpServers` document and normalized `SDL_CONFIG` after this work.

### File-responsibility map

| File | Action | Single responsibility |
| --- | --- | --- |
| `src/cli/commands/init.ts` | Modify | Validate and render Claude Code setup output at the existing client-output seam; select that output during emission. |
| `tests/unit/init-client-config.test.ts` | Create | Focused regression coverage for validation, full-vs-inner JSON shapes, shell quoting, deterministic output, shipped template content, and emitted destination labels. |
| `templates/claude-code.json` | Modify | Shipped canonical Claude Code server template plus honest documentation of the two supported destination forms. |
| `BACKLOG.md` | Local-only update after verification | Record completion evidence for the one Claude Code setup item; this ignored file is not committed. |

Do not create a new renderer module: the design explicitly places the client-specific seam beside `emitClientConfigBlocks`, and one renderer does not justify another abstraction. Do not modify `tests/integration/determinism.fixtures.json` or golden response snapshots: this is CLI stdout/template behavior, not an MCP tool response. The shared determinism and golden checks still run to prove that boundary.

### Task 1: Validate and project one generated Claude server object

**Files:**
- Create: `tests/unit/init-client-config.test.ts`
- Modify: `src/cli/commands/init.ts:2131-2148`
- Reuse: `src/cli/commands/init.ts:1841-1862`
- Reuse: `src/domain/errors.ts:18-23`

- [ ] **Step 1: Create the focused test file with project-shape and malformed-template tests**

Create `tests/unit/init-client-config.test.ts` with this initial content:

```typescript
import assert from "node:assert";
import { describe, it } from "node:test";

import {
  generateClientConfig,
  renderClaudeCodeSetupInstructions,
} from "../../dist/cli/commands/init.js";
import { ConfigError } from "../../dist/domain/errors.js";

const CONFIG_PATH = "F:/work/example/sdlmcp.config.json";

const VALID_TEMPLATE = {
  mcpServers: {
    "sdl-mcp": {
      type: "stdio",
      command: "npx",
      args: ["-y", "sdl-mcp"],
      env: {},
    },
  },
};

describe("Claude Code setup output", () => {
  it("renders project scope as a full document from the generated server object", () => {
    const generated = JSON.parse(
      generateClientConfig(VALID_TEMPLATE, CONFIG_PATH),
    ) as {
      mcpServers: {
        "sdl-mcp": Record<string, unknown>;
      };
    };
    const expectedProject = JSON.stringify(
      {
        mcpServers: {
          "sdl-mcp": generated.mcpServers["sdl-mcp"],
        },
      },
      null,
      2,
    );

    const output = renderClaudeCodeSetupInstructions(
      VALID_TEMPLATE,
      CONFIG_PATH,
    );

    assert.match(
      output,
      /^Project scope \(\.mcp\.json at the repository root\):/m,
    );
    assert.ok(output.includes(expectedProject));
    assert.deepStrictEqual(generated.mcpServers["sdl-mcp"], {
      type: "stdio",
      command: "npx",
      args: ["-y", "sdl-mcp"],
      env: {
        SDL_CONFIG: CONFIG_PATH,
      },
    });
  });

  it("throws ConfigError for every missing or malformed server entry", () => {
    const malformedTemplates: unknown[] = [
      undefined,
      {},
      { mcpServers: null },
      { mcpServers: {} },
      { mcpServers: { "sdl-mcp": null } },
      {
        mcpServers: {
          "sdl-mcp": {
            type: "http",
            command: "npx",
            args: ["-y", "sdl-mcp"],
            env: {},
          },
        },
      },
      {
        mcpServers: {
          "sdl-mcp": {
            type: "stdio",
            command: "",
            args: ["-y", "sdl-mcp"],
            env: {},
          },
        },
      },
      {
        mcpServers: {
          "sdl-mcp": {
            type: "stdio",
            command: "npx",
            args: ["-y", 7],
            env: {},
          },
        },
      },
      {
        mcpServers: {
          "sdl-mcp": {
            type: "stdio",
            command: "npx",
            args: ["-y", "sdl-mcp"],
            env: { SDL_CONFIG: 7 },
          },
        },
      },
    ];

    for (const template of malformedTemplates) {
      assert.throws(
        () => renderClaudeCodeSetupInstructions(template, CONFIG_PATH),
        ConfigError,
      );
    }
  });
});
```

- [ ] **Step 2: Build and run the new test to verify the red state**

Run:

```powershell
npm run build
node --experimental-strip-types --test-concurrency=1 --test tests/unit/init-client-config.test.ts
```

Expected: the build succeeds, then the test process fails while loading `dist/cli/commands/init.js` because `renderClaudeCodeSetupInstructions` is not exported. The failure must name that missing export; a missing fixture or unrelated database error is not the intended red state.

- [ ] **Step 3: Import the typed error and add the minimal validator/project renderer**

Add the ESM import with the existing internal imports in `src/cli/commands/init.ts`:

```typescript
import { ConfigError } from "../../domain/errors.js";
```

Add these helpers immediately before `emitClientConfigBlocks`. The initial renderer intentionally emits only the project block; Task 2 adds shell commands.

```typescript
type JsonObject = Record<string, unknown>;

type ClaudeCodeServerConfig = JsonObject & {
  type: "stdio";
  command: string;
  args: string[];
  env: Record<string, string>;
};

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    isJsonObject(value) &&
    Object.values(value).every((item) => typeof item === "string")
  );
}

function requireClaudeCodeServerConfig(
  document: unknown,
): ClaudeCodeServerConfig {
  const mcpServers =
    isJsonObject(document) && isJsonObject(document.mcpServers)
      ? document.mcpServers
      : undefined;
  const server = mcpServers?.["sdl-mcp"];

  if (
    !isJsonObject(server) ||
    server.type !== "stdio" ||
    typeof server.command !== "string" ||
    server.command.trim().length === 0 ||
    !isStringArray(server.args) ||
    !isStringRecord(server.env)
  ) {
    throw new ConfigError(
      "Invalid Claude Code template: mcpServers.sdl-mcp must be a stdio server with a non-empty command, string[] args, and string-valued env.",
    );
  }

  return server as ClaudeCodeServerConfig;
}

export function renderClaudeCodeSetupInstructions(
  template: unknown,
  configPath: string,
): string {
  // Validate before generateClientConfig dereferences the template shape.
  requireClaudeCodeServerConfig(template);

  const generatedDocument: unknown = JSON.parse(
    generateClientConfig(template, configPath),
  );
  const generatedServer = requireClaudeCodeServerConfig(generatedDocument);
  const projectDocument = {
    mcpServers: {
      "sdl-mcp": generatedServer,
    },
  };

  return [
    "Project scope (.mcp.json at the repository root):",
    JSON.stringify(projectDocument, null, 2),
  ].join("\n");
}
```

Do not change `generateClientConfig`. Its existing spread preserves the server key order from the template and replaces `env` in place after adding normalized `SDL_CONFIG`.

- [ ] **Step 4: Rebuild and run the focused test to verify the green state**

Run:

```powershell
npm run build
node --experimental-strip-types --test-concurrency=1 --test tests/unit/init-client-config.test.ts
```

Expected: `2` tests pass, `0` fail. The malformed cases must fail through `ConfigError`, not a `TypeError` from object dereferencing.

- [ ] **Step 5: Commit the validation/project slice**

```powershell
git diff --cached --name-only
git add src/cli/commands/init.ts tests/unit/init-client-config.test.ts
git diff --cached --check
git diff --cached --name-only
git commit -m "feat(cli): validate Claude Code setup config"
```

Expected: the first staged listing is empty, the second contains only the new focused test and renderer source, the cached diff check is clean, and the commit succeeds. Stop on unrelated staged paths.

### Task 2: Render deterministic PowerShell and POSIX commands

**Files:**
- Modify: `tests/unit/init-client-config.test.ts`
- Modify: `src/cli/commands/init.ts` — `renderClaudeCodeSetupInstructions` and two private quoting helpers

- [ ] **Step 1: Add PowerShell, POSIX, and repeatability tests**

Append these tests inside the existing `describe` block:

```typescript
  it("renders PowerShell local and user commands with one safely quoted JSON argument", () => {
    const quotingTemplate = {
      mcpServers: {
        "sdl-mcp": {
          type: "stdio",
          command: "npx'shim",
          args: ["-y", "sdl-mcp"],
          env: {
            LABEL: "O'Reilly",
          },
        },
      },
    };
    const expectedServerJson = JSON.stringify({
      type: "stdio",
      command: "npx'shim",
      args: ["-y", "sdl-mcp"],
      env: {
        LABEL: "O'Reilly",
        SDL_CONFIG: CONFIG_PATH,
      },
    });
    const output = renderClaudeCodeSetupInstructions(
      quotingTemplate,
      CONFIG_PATH,
      "win32",
    );

    assert.match(
      output,
      /^PowerShell \(run one command; local or user scope\):/m,
    );
    assert.ok(
      output.includes(
        `$sdlMcpConfig = '${expectedServerJson.replaceAll("'", "''")}'`,
      ),
    );
    assert.match(
      output,
      /^claude mcp add-json --scope local sdl-mcp \$sdlMcpConfig$/m,
    );
    assert.match(
      output,
      /^claude mcp add-json --scope user sdl-mcp \$sdlMcpConfig$/m,
    );
    assert.match(
      output,
      /cmd\.exe users: use the project \.mcp\.json form or run the PowerShell snippet\./,
    );
    assert.doesNotMatch(output, /cmd\.exe[^\n]*add-json/i);
    assert.equal(
      renderClaudeCodeSetupInstructions(
        quotingTemplate,
        CONFIG_PATH,
        "win32",
      ),
      output,
    );
  });

  it("renders POSIX local and user commands with the JSON variable double-quoted", () => {
    const quotingTemplate = {
      mcpServers: {
        "sdl-mcp": {
          type: "stdio",
          command: "npx'shim",
          args: ["-y", "sdl-mcp"],
          env: {
            LABEL: "O'Reilly",
          },
        },
      },
    };
    const expectedServerJson = JSON.stringify({
      type: "stdio",
      command: "npx'shim",
      args: ["-y", "sdl-mcp"],
      env: {
        LABEL: "O'Reilly",
        SDL_CONFIG: CONFIG_PATH,
      },
    });
    const expectedAssignment =
      `sdl_mcp_config='${expectedServerJson.replaceAll("'", "'\\''")}'`;
    const output = renderClaudeCodeSetupInstructions(
      quotingTemplate,
      CONFIG_PATH,
      "linux",
    );

    assert.match(
      output,
      /^POSIX shell \(run one command; local or user scope\):/m,
    );
    assert.ok(output.includes(expectedAssignment));
    assert.match(
      output,
      /^claude mcp add-json --scope local sdl-mcp "\$sdl_mcp_config"$/m,
    );
    assert.match(
      output,
      /^claude mcp add-json --scope user sdl-mcp "\$sdl_mcp_config"$/m,
    );
    assert.equal(
      renderClaudeCodeSetupInstructions(
        quotingTemplate,
        CONFIG_PATH,
        "linux",
      ),
      output,
    );
  });
```

The apostrophes in both `command` and `env` prove that quoting is applied to arbitrary compact JSON, not only the current simple template.

- [ ] **Step 2: Run the focused test to verify the shell-rendering red state**

Run:

```powershell
npm run build
node --experimental-strip-types --test-concurrency=1 --test tests/unit/init-client-config.test.ts
```

Expected: the original `2` tests pass and the new `2` tests fail because the renderer has no platform parameter, variable assignment, scope commands, or shell labels.

- [ ] **Step 3: Add quoting helpers and replace the renderer with the complete platform-specific implementation**

Add the quoting helpers beside `requireClaudeCodeServerConfig`:

```typescript
function quotePowerShellSingle(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function quotePosixSingle(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
```

Replace `renderClaudeCodeSetupInstructions` with:

```typescript
export function renderClaudeCodeSetupInstructions(
  template: unknown,
  configPath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  // Validate before generateClientConfig dereferences the template shape.
  requireClaudeCodeServerConfig(template);

  const generatedDocument: unknown = JSON.parse(
    generateClientConfig(template, configPath),
  );
  const generatedServer = requireClaudeCodeServerConfig(generatedDocument);
  const serverJson = JSON.stringify(generatedServer);
  const projectJson = JSON.stringify(
    {
      mcpServers: {
        "sdl-mcp": generatedServer,
      },
    },
    null,
    2,
  );

  const shellLines =
    platform === "win32"
      ? [
          "PowerShell (run one command; local or user scope):",
          `$sdlMcpConfig = ${quotePowerShellSingle(serverJson)}`,
          "claude mcp add-json --scope local sdl-mcp $sdlMcpConfig",
          "claude mcp add-json --scope user sdl-mcp $sdlMcpConfig",
          "cmd.exe users: use the project .mcp.json form or run the PowerShell snippet.",
        ]
      : [
          "POSIX shell (run one command; local or user scope):",
          `sdl_mcp_config=${quotePosixSingle(serverJson)}`,
          'claude mcp add-json --scope local sdl-mcp "$sdl_mcp_config"',
          'claude mcp add-json --scope user sdl-mcp "$sdl_mcp_config"',
        ];

  return [
    "Project scope (.mcp.json at the repository root):",
    projectJson,
    "",
    ...shellLines,
  ].join("\n");
}
```

Key ordering stays deterministic because the renderer reuses the generated server object's insertion order and constructs the wrapper in a fixed literal order. Do not add timestamps, detected home paths, session data, or platform-specific absolute paths.

- [ ] **Step 4: Rebuild and run the focused test to verify both shell variants are green**

Run:

```powershell
npm run build
node --experimental-strip-types --test-concurrency=1 --test tests/unit/init-client-config.test.ts
```

Expected: `4` tests pass, `0` fail. Each platform's repeated render must be byte-identical, and both scope commands must pass a variable rather than inline JSON.

- [ ] **Step 5: Commit the shell-safe renderer slice**

```powershell
git diff --cached --name-only
git add src/cli/commands/init.ts tests/unit/init-client-config.test.ts
git diff --cached --check
git diff --cached --name-only
git commit -m "feat(cli): render shell-safe Claude MCP commands"
```

Expected: the first staged listing is empty, the second is limited to quoting/platform rendering and its focused tests, the cached diff check is clean, and the commit succeeds.

### Task 3: Wire the emitter and update the shipped Claude template

**Files:**
- Modify: `tests/unit/init-client-config.test.ts`
- Modify: `src/cli/commands/init.ts:2131-2148` — `emitClientConfigBlocks`
- Modify: `templates/claude-code.json`
- Reference only: `tests/unit/init-claude-config-dir.test.ts`

- [ ] **Step 1: Extend test imports for the shipped template and emitter**

Add the filesystem imports and the two exports to `tests/unit/init-client-config.test.ts`:

```typescript
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
```

The init-module import must now be:

```typescript
import {
  emitClientConfigBlocks,
  generateClientConfig,
  loadClientTemplate,
  renderClaudeCodeSetupInstructions,
} from "../../dist/cli/commands/init.js";
```

- [ ] **Step 2: Add the shipped-template contract test**

Append inside the `describe` block:

```typescript
  it("keeps the shipped Claude template canonical and documents both destination forms", async () => {
    const template = await loadClientTemplate("claude-code");
    const generated = JSON.parse(
      generateClientConfig(template, CONFIG_PATH),
    ) as {
      mcpServers: {
        "sdl-mcp": Record<string, unknown>;
      };
    };
    const templateDocumentation = JSON.stringify(
      (template as { _documentation?: unknown })._documentation,
    );

    assert.deepStrictEqual(generated.mcpServers["sdl-mcp"], {
      type: "stdio",
      command: "npx",
      args: ["-y", "sdl-mcp"],
      env: {
        SDL_CONFIG: CONFIG_PATH,
      },
    });
    assert.ok(templateDocumentation);
    assert.match(templateDocumentation, /\.mcp\.json/);
    assert.match(templateDocumentation, /claude mcp add-json/);
    assert.match(templateDocumentation, /--scope local/);
    assert.match(templateDocumentation, /--scope user/);
    assert.doesNotMatch(
      templateDocumentation,
      /\.claude[/\\]settings\.json|~[/\\]\.claude\.json/,
    );
  });
```

This test intentionally checks the generated server object, not only raw template text: the shipped template begins with `env: {}`, while the unchanged generic generator adds `SDL_CONFIG`.

- [ ] **Step 3: Add the emitted-destination regression test**

Append inside the same `describe` block:

```typescript
  it("emits Claude setup destinations without presenting the detected settings path", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "sdl-claude-output-"));
    const envKeys = [
      "HOME",
      "USERPROFILE",
      "APPDATA",
      "CLAUDE_CONFIG_DIR",
      "CODEX_HOME",
      "XDG_CONFIG_HOME",
      "FLATPAK_XDG_CONFIG_HOME",
    ] as const;
    const previousEnv = envKeys.map(
      (key) => [key, process.env[key]] as const,
    );
    const originalLog = console.log;
    const lines: string[] = [];

    try {
      for (const key of envKeys) {
        delete process.env[key];
      }
      process.env.HOME = tempRoot;
      process.env.USERPROFILE = tempRoot;
      process.env.APPDATA = join(tempRoot, "appdata");
      process.env.CLAUDE_CONFIG_DIR = join(tempRoot, "custom-claude");
      process.env.CODEX_HOME = join(tempRoot, "missing-codex");
      process.env.XDG_CONFIG_HOME = join(tempRoot, "missing-xdg");
      process.env.FLATPAK_XDG_CONFIG_HOME = join(
        tempRoot,
        "missing-flatpak-xdg",
      );
      console.log = (...values: unknown[]) => {
        lines.push(values.map(String).join(" "));
      };

      await emitClientConfigBlocks(CONFIG_PATH, "win32");

      const output = lines.join("\n");
      assert.match(
        output,
        /- claude-code:\nProject scope \(\.mcp\.json at the repository root\):/,
      );
      assert.match(output, /PowerShell/);
      assert.match(
        output,
        /claude mcp add-json --scope local sdl-mcp \$sdlMcpConfig/,
      );
      assert.match(
        output,
        /claude mcp add-json --scope user sdl-mcp \$sdlMcpConfig/,
      );
      assert.equal((output.match(/claude mcp add-json/g) ?? []).length, 2);
      assert.ok(
        !output.includes(tempRoot),
        "detected Claude settings path must not be printed as a destination",
      );
    } finally {
      console.log = originalLog;
      for (const [key, value] of previousEnv) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
```

- [ ] **Step 4: Run the focused test to verify the template/emitter red state**

Run:

```powershell
npm run build
node --experimental-strip-types --test-concurrency=1 --test tests/unit/init-client-config.test.ts
```

Expected: the first `4` tests pass. The shipped-template test fails because the current template lacks `type: "stdio"` and still uses stale arguments/documentation. The emission test fails because the existing exported `emitClientConfigBlocks` ignores the second platform argument, renders for the host platform, and still prints `detection.configPath` for Claude.

- [ ] **Step 5: Replace the Claude template with the canonical full document and destination documentation**

Replace all content in `templates/claude-code.json` with:

```json
{
  "_comment": "Claude Code MCP Configuration Template for SDL-MCP",
  "_documentation": {
    "purpose": "Configure SDL-MCP as a stdio MCP server for Claude Code",
    "destinations": {
      "project": "Save the full mcpServers document as .mcp.json in the repository root.",
      "cli": "For local or user scope, pass only mcpServers.sdl-mcp to claude mcp add-json; use --scope local or --scope user."
    },
    "windows": "Use the emitted PowerShell snippet. cmd.exe users should use the project .mcp.json form or run the PowerShell snippet."
  },
  "mcpServers": {
    "sdl-mcp": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "sdl-mcp"],
      "env": {}
    }
  }
}
```

Do not reintroduce `~/.claude.json`, `.claude/settings.json`, inline `cmd.exe` quoting, `sdl-mcp@latest`, or the old `serve --stdio` arguments.

- [ ] **Step 6: Route only Claude Code through the renderer and stop printing its detected path**

Replace `emitClientConfigBlocks` with:

```typescript
async function emitClientConfigBlocks(
  configPath: string,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  const detections = detectInstalledClients();
  console.log("");
  console.log("Detected MCP clients and config blocks:");

  for (const detection of detections) {
    let block: string;
    const isClaudeCode = detection.templateClient === "claude-code";

    if (detection.templateClient) {
      const template = await loadClientTemplate(detection.templateClient);
      block = isClaudeCode
        ? renderClaudeCodeSetupInstructions(template, configPath, platform)
        : generateClientConfig(template, configPath);
    } else {
      block = buildGenericClientConfig(configPath);
    }

    console.log(
      isClaudeCode
        ? `- ${detection.name}:`
        : `- ${detection.name}: ${detection.configPath}`,
    );
    console.log(block);
    console.log("");
  }
}
```

Keep the declaration non-inline-exported: the module's existing export list already exports `emitClientConfigBlocks`. Do not add a second inline `export` or remove/reorder the export-list entry. The block is fully validated/rendered before its label or any command is printed. A malformed `mcpServers.sdl-mcp` therefore throws `ConfigError` without emitting a plausible setup command. The initial non-command section heading may already have been printed, which is compatible with the spec's “before any command” boundary.

- [ ] **Step 7: Rebuild and run the focused test to verify all Claude contracts are green**

Run:

```powershell
npm run build
node --experimental-strip-types --test-concurrency=1 --test tests/unit/init-client-config.test.ts
```

Expected: `6` tests pass, `0` fail. The emitted Windows output contains a project block plus exactly one local and one user command, and contains neither the synthetic Claude settings path nor any other temp-home path.

- [ ] **Step 8: Re-run the existing Claude detection regression**

Run:

```powershell
node --experimental-strip-types --test-concurrency=1 --test tests/unit/init-claude-config-dir.test.ts
```

Expected: all existing detection tests pass. This proves detection still recognizes `CLAUDE_CONFIG_DIR` even though the detected settings path is no longer presented as an MCP destination.

- [ ] **Step 9: Commit the emitter/template slice**

```powershell
git diff --cached --name-only
git add src/cli/commands/init.ts tests/unit/init-client-config.test.ts templates/claude-code.json
git diff --cached --check
git diff --cached --name-only
git commit -m "fix(cli): emit valid Claude Code setup destinations"
```

Expected: the first staged listing is empty, the second is limited to emitter integration, shipped template, and tests, the cached diff check is clean, and the commit succeeds.

### Task 4: Run focused and shared completion gates

**Files:**
- Verify: `src/cli/commands/init.ts`
- Verify: `tests/unit/init-client-config.test.ts`
- Verify: `tests/unit/init-claude-config-dir.test.ts`
- Verify: `templates/claude-code.json`
- Verify unchanged: `tests/integration/determinism.fixtures.json` and golden snapshots
- Local-only reconcile: `BACKLOG.md:13-16`

- [ ] **Step 1: Run the full build**

Run:

```powershell
npm run build:all
```

Expected: exit code `0`; TypeScript emits `dist` and script builds without errors.

- [ ] **Step 2: Run repository typechecking**

Run:

```powershell
npm run typecheck
```

Expected: exit code `0` with no TypeScript diagnostics.

- [ ] **Step 3: Run both focused Claude test files together**

Run:

```powershell
node --experimental-strip-types --test-concurrency=1 --test tests/unit/init-client-config.test.ts tests/unit/init-claude-config-dir.test.ts
```

Expected: every test passes, `# fail 0`. The new file contributes `6` passing tests.

- [ ] **Step 4: Run lint**

Run:

```powershell
npm run lint
```

Expected: exit code `0` with zero ESLint errors, including import ordering and mandatory `.js` extensions.

- [ ] **Step 5: Run documentation/workflow inventory checks**

Run:

```powershell
npm run docs:tools:check
```

Expected: exit code `0`. No generated workflow or tool inventory requires an update for this CLI-only change.

- [ ] **Step 6: Run prompt-cache determinism coverage**

Run:

```powershell
npm run build
node --experimental-strip-types --test-concurrency=1 --test tests/integration/determinism.test.ts
```

Expected: exit code `0` and all determinism fixtures pass unchanged. If this command produces a fixture diff, stop and investigate; do not update `tests/integration/determinism.fixtures.json` for CLI output.

- [ ] **Step 7: Validate golden MCP responses**

Run:

```powershell
npm run test:golden
```

Expected: exit code `0` with no golden changes. The Claude setup renderer is outside the MCP response contract.

- [ ] **Step 8: Run the full test suite**

Run:

```powershell
npm test
```

Expected: exit code `0` with no failed unit, integration, golden, property, benchmark, or root tests. A partial suite is not completion evidence.

- [ ] **Step 9: Confirm no generated or backup artifacts remain**

Run:

```powershell
git status --short
```

Expected: `git status --short` is empty after the three scoped commits. The focused tests remove their named temporary directory in `finally`. Remove only SDL edit-backup paths explicitly returned during this track after verifying each lies inside the implementation worktree; if no backup path was captured, delete nothing.

- [ ] **Step 10: Reconcile the ignored local backlog item only after every gate is green**

Do not assume the ignored backlog exists in the implementation worktree. Send the focused/shared command results, persisted runtime handles, and commit ids to the root-workspace owner. That owner uses SDL `sdl.file.read` to re-read `BACKLOG.md` around “Correct Claude Code MCP setup output,” changes only that checkbox from `[ ]` to `[x]` after every gate is green, adds this evidence line, and performs an SDL readback:

```markdown
  - Verification evidence: focused Claude output/detection tests, build, typecheck, lint, documentation checks, determinism, golden validation, and the full test suite passed; the shipped template and emitted project/local/user forms now agree.
```

Then run:

```powershell
git check-ignore -q BACKLOG.md
```

Expected: exit code `0`, confirming the reconciliation remains local and is not accidentally added to a commit. If any gate failed, leave the checkbox unchecked and record the failing command plus the next action instead.

### Final compatibility checklist

- [ ] Generated client files still contain the outer `mcpServers` document and normalized `SDL_CONFIG`.
- [ ] Project instructions name repository-root `.mcp.json` and print the full wrapper.
- [ ] Local and user instructions pass only compact `mcpServers.sdl-mcp` JSON.
- [ ] Scope ordering is exactly `claude mcp add-json --scope <local|user> sdl-mcp <json-argument>`.
- [ ] PowerShell doubles embedded apostrophes and passes `$sdlMcpConfig` as one argument.
- [ ] POSIX shell uses the close-quote/escaped-apostrophe/reopen-quote sequence and passes `"$sdl_mcp_config"` as one argument.
- [ ] Windows output is labeled PowerShell and emits no inline `cmd.exe` JSON command.
- [ ] Invalid `mcpServers.sdl-mcp` shapes throw `ConfigError` before a setup command is printed.
- [ ] Other clients retain their existing detected-path labels and generic rendering.
- [ ] Identical template, config path, and platform inputs produce byte-identical output.
- [ ] No MCP determinism fixture or golden snapshot changed.
