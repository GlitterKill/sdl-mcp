import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";

import {
  emitClientConfigBlocks,
  generateClientConfig,
  loadClientTemplate,
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
});
