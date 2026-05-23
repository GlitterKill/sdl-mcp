import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  resolveConfiguredPluginPaths,
  resolveConfiguredPluginTrustedRoots,
} from "../../dist/startup/plugins.js";

describe("configured plugin startup paths", () => {
  it("resolves relative plugin paths from the active config directory", () => {
    const configPath = path.join("tmp", "config", "sdlmcp.config.json");
    const resolved = resolveConfiguredPluginPaths(
      ["./plugins/example/dist/index.js"],
      configPath,
    );

    assert.equal(
      resolved[0],
      path.resolve("tmp", "config", "plugins", "example", "dist", "index.js"),
    );
  });

  it("uses config-relative trusted roots when configured", () => {
    const configPath = path.join("tmp", "config", "sdlmcp.config.json");
    const resolvedPaths = resolveConfiguredPluginPaths(
      ["./plugins/example/dist/index.js"],
      configPath,
    );

    const roots = resolveConfiguredPluginTrustedRoots(
      ["./plugins/example/dist/index.js"],
      resolvedPaths,
      ["./plugins"],
      configPath,
    );

    assert.deepEqual(roots, [path.resolve("tmp", "config", "plugins")]);
  });

  it("defaults relative plugin trust to the config directory", () => {
    const configPath = path.join("tmp", "config", "sdlmcp.config.json");
    const resolvedPaths = resolveConfiguredPluginPaths(
      ["./plugins/example/dist/index.js"],
      configPath,
    );

    const roots = resolveConfiguredPluginTrustedRoots(
      ["./plugins/example/dist/index.js"],
      resolvedPaths,
      [],
      configPath,
    );

    assert.deepEqual(roots, [path.resolve("tmp", "config")]);
  });

  it("defaults absolute plugin trust to the plugin entrypoint directory", () => {
    const configPath = path.join("tmp", "config", "sdlmcp.config.json");
    const pluginPath = path.resolve("tmp", "plugins", "example.mjs");
    const resolvedPaths = resolveConfiguredPluginPaths([pluginPath], configPath);

    const roots = resolveConfiguredPluginTrustedRoots(
      [pluginPath],
      resolvedPaths,
      [],
      configPath,
    );

    assert.deepEqual(roots, [path.dirname(pluginPath)]);
  });

  it("loads configured plugins in server and CLI startup paths", () => {
    const expectations = [
      ["src/main.ts", "loadConfiguredAdapterPlugins(config, resolvedConfigPath"],
      ["src/cli/commands/serve.ts", "loadConfiguredAdapterPlugins(config, configPath"],
      ["src/cli/commands/index.ts", "loadConfiguredAdapterPlugins(config, configPath"],
      ["src/cli/commands/tool-dispatch.ts", "loadConfiguredAdapterPlugins(config, configPath"],
    ] as const;

    for (const [filePath, expectedCall] of expectations) {
      const source = readFileSync(path.resolve(filePath), "utf-8");
      assert.match(source, /loadConfiguredAdapterPlugins/);
      assert.ok(source.includes(expectedCall), filePath);
    }
  });

  it("does not load CLI plugins before delegated or metadata-only paths", () => {
    const indexSource = readFileSync(
      path.resolve("src/cli/commands/index.ts"),
      "utf-8",
    );
    assert.ok(
      indexSource.indexOf("if (!canDelegate)") <
        indexSource.indexOf("loadConfiguredAdapterPlugins(config, configPath"),
      "direct index plugin loading should happen only after delegation is ruled out",
    );

    const toolDispatchSource = readFileSync(
      path.resolve("src/cli/commands/tool-dispatch.ts"),
      "utf-8",
    );
    assert.ok(
      toolDispatchSource.indexOf("if (isCliProxyMetaAction(action))") <
        toolDispatchSource.indexOf("loadConfiguredAdapterPlugins(config, configPath"),
      "metadata-only CLI actions should return before plugin loading",
    );
  });

  it("keeps plugin SDK trustedRoots examples aligned with plugin paths", () => {
    const source = readFileSync(
      path.resolve("docs/plugin-sdk-author-guide.md"),
      "utf-8",
    );
    const snippets = source.matchAll(
      /"paths":\s*\[\s*"([^"]+)"\s*\][\s\S]{0,160}?"trustedRoots":\s*\[\s*"(\.\/plugins)"\s*\]/g,
    );
    let checked = 0;

    for (const match of snippets) {
      checked += 1;
      const pluginPath = match[1];
      const trustedRoot = match[2];
      assert.ok(
        pluginPath.startsWith(`${trustedRoot}/`),
        `${pluginPath} must resolve inside ${trustedRoot}`,
      );
    }

    assert.ok(checked > 0, "expected at least one trustedRoots example");
  });
});
