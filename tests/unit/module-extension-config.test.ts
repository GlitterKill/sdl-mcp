import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RepoConfigSchema } from "../../dist/config/types.js";
import { scanRepository, getLanguageExtensions } from "../../dist/indexer/fileScanner.js";
import { getLanguageIdForExtension } from "../../dist/indexer/adapter/registry.js";
import { extensionToLanguage } from "../../dist/indexer/rustIndexer.js";

it("explicit JS/TS module selectors validate, scan, and route without broadening js/ts", async () => {
  const rootPath = await mkdtemp(join(tmpdir(), "sdl-module-selectors-"));
  try {
    const extensions = ["js", "ts", "jsx", "tsx", "mjs", "cjs", "mts", "cts"];
    await Promise.all(extensions.map((ext) => writeFile(join(rootPath, "module." + ext), "export const value = 1;")));
    for (const language of ["mjs", "cjs", "mts", "cts"]) {
      const config = RepoConfigSchema.parse({ repoId: "module-test", rootPath, languages: [language] });
      const files = await scanRepository(rootPath, config);
      assert.deepEqual(files.map((file) => file.path), ["module." + language]);
      assert.equal(getLanguageIdForExtension("." + language), "typescript");
      assert.equal(extensionToLanguage(language), language.endsWith("js") ? "js" : "ts");
    }
    assert.deepEqual(getLanguageExtensions(["js"]), [".js"]);
    assert.deepEqual(getLanguageExtensions(["ts"]), [".ts"]);
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
});
