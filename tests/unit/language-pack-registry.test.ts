import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  resolveConfiguredLanguagePacks,
  resolveLanguagePack,
} from "../../dist/indexer/language-packs.js";
import { getLanguageExtensions } from "../../dist/indexer/fileScanner.js";

describe("on-demand language pack registry", () => {
  it("describes Wave 0, Wave 1, and Wave 2 packs as configured-only parser installs", () => {
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
      ["lua", "lua", "@tree-sitter-grammars/tree-sitter-lua", "lua-language-server"],
      ["dart", "dart", "@sengac/tree-sitter-dart", "dart-sdk-lsp"],
      ["swift", "swift", "tree-sitter-swift", "sourcekit-lsp"],
      ["groovy", "groovy", "tree-sitter-groovy", "groovy-language-server"],
      ["perl", "perl", "tree-sitter-perl", "perl-navigator"],
      ["r", "r", "@davisvaughan/tree-sitter-r", "r-languageserver"],
      ["elixir", "elixir", "tree-sitter-elixir", "expert"],
      ["fsharp", "fsharp", "tree-sitter-fsharp", "fsautocomplete"],
      ["fortran", "fortran", "tree-sitter-fortran", "fortls"],
      [
        "haskell",
        "haskell",
        "tree-sitter-haskell",
        "haskell-language-server",
      ],
      ["julia", "julia", "tree-sitter-julia", "julia-language-server"],
      ["nix", "nix", "tree-sitter-nix", "nil"],
      ["clojure", "clojure", "@yogthos/tree-sitter-clojure", "clojure-lsp"],
      ["ocaml", "ocaml", "tree-sitter-ocaml", "ocamllsp"],
      ["d", "d", "tree-sitter-d", "serve-d"],
      ["haxe", "haxe", "tree-sitter-haxe", "haxe-language-server"],
      ["commonlisp", "commonlisp", "tree-sitter-commonlisp", "cl-lsp"],
      ["gleam", "gleam", "tree-sitter-gleam", "gleam-lsp"],
      ["zig", "zig", "tree-sitter-zig", "zls"],
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
        "groovy",
        "perl",
        "r",
        "elixir",
        "fsharp",
        "fortran",
        "haskell",
        "julia",
        "nix",
        "clojure",
        "ocaml",
        "d",
        "haxe",
        "commonlisp",
        "gleam",
        "zig",
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
        { languageId: "lua", parserPackage: "@tree-sitter-grammars/tree-sitter-lua" },
        { languageId: "dart", parserPackage: "@sengac/tree-sitter-dart" },
        { languageId: "swift", parserPackage: "tree-sitter-swift" },
        { languageId: "groovy", parserPackage: "tree-sitter-groovy" },
        { languageId: "perl", parserPackage: "tree-sitter-perl" },
        { languageId: "r", parserPackage: "@davisvaughan/tree-sitter-r" },
        { languageId: "elixir", parserPackage: "tree-sitter-elixir" },
        { languageId: "fsharp", parserPackage: "tree-sitter-fsharp" },
        { languageId: "fortran", parserPackage: "tree-sitter-fortran" },
        { languageId: "haskell", parserPackage: "tree-sitter-haskell" },
        { languageId: "julia", parserPackage: "tree-sitter-julia" },
        { languageId: "nix", parserPackage: "tree-sitter-nix" },
        { languageId: "clojure", parserPackage: "@yogthos/tree-sitter-clojure" },
        { languageId: "ocaml", parserPackage: "tree-sitter-ocaml" },
        { languageId: "d", parserPackage: "tree-sitter-d" },
        { languageId: "haxe", parserPackage: "tree-sitter-haxe" },
        { languageId: "commonlisp", parserPackage: "tree-sitter-commonlisp" },
        { languageId: "gleam", parserPackage: "tree-sitter-gleam" },
        { languageId: "zig", parserPackage: "tree-sitter-zig" },
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
      ".groovy",
      ".pl",
      ".R",
      ".ex",
      ".fs",
      ".f90",
      ".hs",
      ".jl",
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
    assert.ok(getLanguageExtensions(["groovy"]).includes(".groovy"));
    assert.ok(getLanguageExtensions(["perl"]).includes(".pl"));
    assert.ok(getLanguageExtensions(["r"]).includes(".R"));
    assert.ok(getLanguageExtensions(["elixir"]).includes(".ex"));
    assert.ok(getLanguageExtensions(["fsharp"]).includes(".fs"));
    assert.ok(getLanguageExtensions(["fortran"]).includes(".f90"));
    assert.ok(getLanguageExtensions(["haskell"]).includes(".hs"));
    assert.ok(getLanguageExtensions(["julia"]).includes(".jl"));
    assert.ok(getLanguageExtensions(["ocaml"]).includes(".ml"));
    assert.ok(getLanguageExtensions(["d"]).includes(".d"));
    assert.ok(getLanguageExtensions(["haxe"]).includes(".hx"));
    assert.ok(getLanguageExtensions(["commonlisp"]).includes(".lisp"));
    assert.ok(getLanguageExtensions(["gleam"]).includes(".gleam"));
    assert.ok(getLanguageExtensions(["zig"]).includes(".zig"));
  });
});
