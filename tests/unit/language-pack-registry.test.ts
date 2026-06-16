import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  resolveConfiguredLanguagePacks,
  resolveLanguagePack,
} from "../../dist/indexer/language-packs.js";
import { getLanguageExtensions } from "../../dist/indexer/fileScanner.js";

describe("on-demand language pack registry", () => {
  it("describes Wave 0 and Wave 1 packs as configured-only parser installs", () => {
    const expected = [
      ["php", "php", "tree-sitter-php", "phpactor"],
      ["sh", "shell", "tree-sitter-bash", "bash-language-server"],
      [
        "powershell",
        "powershell",
        "tree-sitter-powershell",
        "powershell-editor-services",
      ],
      ["ruby", "ruby", "tree-sitter-ruby", "ruby-lsp"],
      ["lua", "lua", "tree-sitter-lua", "lua-language-server"],
      ["dart", "dart", "tree-sitter-dart", "dart-sdk-lsp"],
      ["swift", "swift", "tree-sitter-swift", "sourcekit-lsp"],
    ] as const;

    for (const [alias, languageId, parserPackage, lspServerId] of expected) {
      const pack = resolveLanguagePack(alias);
      assert.equal(pack?.languageId, languageId);
      assert.equal(pack?.installMode, "onDemand");
      assert.equal(pack?.parserPackage, parserPackage);
      assert.equal(pack?.lspServerId, lspServerId);
    }
  });

  it("only resolves lazy parser packs for languages explicitly configured", () => {
    assert.deepEqual(resolveConfiguredLanguagePacks(["ts", "py"]), []);

    assert.deepEqual(
      resolveConfiguredLanguagePacks([
        "php",
        "sh",
        "powershell",
        "ruby",
        "lua",
        "dart",
        "swift",
      ]).map((pack) => ({
        languageId: pack.languageId,
        parserPackage: pack.parserPackage,
      })),
      [
        { languageId: "php", parserPackage: "tree-sitter-php" },
        { languageId: "shell", parserPackage: "tree-sitter-bash" },
        {
          languageId: "powershell",
          parserPackage: "tree-sitter-powershell",
        },
        { languageId: "ruby", parserPackage: "tree-sitter-ruby" },
        { languageId: "lua", parserPackage: "tree-sitter-lua" },
        { languageId: "dart", parserPackage: "tree-sitter-dart" },
        { languageId: "swift", parserPackage: "tree-sitter-swift" },
      ],
    );
  });

  it("keeps lazy language extensions out of default scans until configured", () => {
    for (const extension of [
      ".php",
      ".sh",
      ".ps1",
      ".rb",
      ".lua",
      ".dart",
      ".swift",
    ]) {
      assert.equal(getLanguageExtensions(["ts", "py"]).includes(extension), false);
    }

    assert.ok(getLanguageExtensions(["php"]).includes(".php"));
    assert.ok(getLanguageExtensions(["sh"]).includes(".sh"));
    assert.ok(getLanguageExtensions(["powershell"]).includes(".ps1"));
    assert.ok(getLanguageExtensions(["ruby"]).includes(".rb"));
    assert.ok(getLanguageExtensions(["lua"]).includes(".lua"));
    assert.ok(getLanguageExtensions(["dart"]).includes(".dart"));
    assert.ok(getLanguageExtensions(["swift"]).includes(".swift"));
  });
});
