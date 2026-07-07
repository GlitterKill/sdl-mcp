import assert from "node:assert";
import { sep } from "node:path";
import { describe, it } from "node:test";

import { ViewerConfigSchema } from "../../dist/config/types.js";
import {
  _resetViewerRuntimeConfigForTesting,
  getViewerRuntimeConfig,
  resolveLayoutCacheDir,
  resolveSkinsDir,
  setViewerRuntimeConfig,
} from "../../dist/viewer/viewer-config.js";

describe("viewer config", () => {
  it("applies SDL Galaxy defaults", () => {
    const parsed = ViewerConfigSchema.parse({});

    assert.equal(parsed.enabled, true);
    assert.equal(parsed.fps, 60);
    assert.equal(parsed.ambient.enabled, true);
    assert.equal(parsed.ambient.idleSeconds, 180);
    assert.equal(parsed.ambient.fps, 30);
    assert.equal(parsed.layout.engine, "auto");
    assert.equal(parsed.layout.iterations, 300);
    assert.equal(parsed.layout.maxSymbolsPerClusterExpand, 5000);
    assert.equal(parsed.skins.maxZipBytes, 52_428_800);
  });

  it("rejects unsupported FPS values", () => {
    assert.throws(() => ViewerConfigSchema.parse({ fps: 45 }));
    assert.throws(() => ViewerConfigSchema.parse({ ambient: { fps: 45 } }));
  });

  it("wires the loaded viewer config into the runtime with configDir-relative defaults", () => {
    try {
      setViewerRuntimeConfig(
        { fps: 120, layout: { iterations: 500 } },
        `${sep}srv${sep}sdl${sep}sdlmcp.config.json`,
      );
      const runtime = getViewerRuntimeConfig();
      assert.equal(runtime.fps, 120);
      assert.equal(runtime.layout.iterations, 500);
      assert(resolveSkinsDir().endsWith(`${sep}srv${sep}sdl${sep}skins`));
      assert(resolveLayoutCacheDir().endsWith(`${sep}srv${sep}sdl${sep}viewer-layout-cache`));

      setViewerRuntimeConfig({ skinsDir: `${sep}custom${sep}skins` }, `${sep}srv${sep}sdl${sep}sdlmcp.config.json`);
      assert(resolveSkinsDir().endsWith(`${sep}custom${sep}skins`));
    } finally {
      _resetViewerRuntimeConfigForTesting();
    }

    // Unwired fallback stays on schema defaults.
    assert.equal(getViewerRuntimeConfig().fps, 60);
  });
});
