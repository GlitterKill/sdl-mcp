import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  resolveConfiguredLanguagePacks,
  resolveLanguagePack,
} from "../../dist/indexer/language-packs.js";
import { getLanguageExtensions } from "../../dist/indexer/fileScanner.js";

describe("on-demand language pack registry", () => {
  it("describes wave 0 PHP and Shell packs as configured-only parser installs", () => {
    const php = resolveLanguagePack("php");
    const shell = resolveLanguagePack("sh");

    assert.equal(php?.languageId, "php");
    assert.equal(php?.installMode, "onDemand");
    assert.equal(php?.parserPackage, "tree-sitter-php");
    assert.equal(php?.lspServerId, "phpactor");
    assert.equal(shell?.languageId, "shell");
    assert.equal(shell?.installMode, "onDemand");
    assert.equal(shell?.parserPackage, "tree-sitter-bash");
    assert.equal(shell?.lspServerId, "bash-language-server");
  });

  it("only resolves lazy parser packs for languages explicitly configured", () => {
    assert.deepEqual(resolveConfiguredLanguagePacks(["ts", "py"]), []);

    assert.deepEqual(
      resolveConfiguredLanguagePacks(["php", "sh"]).map((pack) => ({
        languageId: pack.languageId,
        parserPackage: pack.parserPackage,
      })),
      [
        { languageId: "php", parserPackage: "tree-sitter-php" },
        { languageId: "shell", parserPackage: "tree-sitter-bash" },
      ],
    );
  });

  it("keeps PHP and Shell extensions out of default scans until configured", () => {
    assert.equal(getLanguageExtensions(["ts", "py"]).includes(".php"), false);
    assert.equal(getLanguageExtensions(["ts", "py"]).includes(".sh"), false);

    assert.ok(getLanguageExtensions(["php"]).includes(".php"));
    assert.ok(getLanguageExtensions(["sh"]).includes(".sh"));
  });
});
