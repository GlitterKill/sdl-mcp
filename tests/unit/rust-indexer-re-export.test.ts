import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isRustEngineAvailable,
  parseFilesRust,
} from "../../dist/indexer/rustIndexer.js";

/**
 * Task 1.3: re-export detection parity between Rust and TS Pass-1 engines.
 *
 * These tests require the native addon. When it is unavailable (e.g. when
 * `SDL_MCP_DISABLE_NATIVE_ADDON=1` is set, which is the default for `npm test`),
 * each test returns early — mirroring the established rust-indexer.test.ts
 * skip pattern.
 */
describe("rustIndexer — NativeParsedImport.isReExport parity", () => {
  let tmpDir: string;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "sdl-mcp-reexport-test-"));
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("TypeScript `export * from './foo'` is marked as a re-export", () => {
    if (!isRustEngineAvailable()) return;

    const relPath = "src/barrel.ts";
    const absPath = join(tmpDir, relPath);
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    writeFileSync(
      absPath,
      [
        'export * from "./foo.js";',
        'export { named } from "./bar.js";',
        'import { helper } from "./utils.js";',
        "export const direct = helper;",
      ].join("\n"),
      "utf8",
    );

    const result = parseFilesRust("test-repo", tmpDir, [
      { path: relPath, size: 0, mtime: Date.now() },
    ]);
    assert.ok(
      result !== null,
      "parseFilesRust should return a non-null result",
    );
    assert.strictEqual(result.length, 1);
    const parsed = result[0]!;
    assert.ok(!parsed.parseError, `parse should succeed, got: ${parsed.parseError ?? ""}`);
    assert.ok(parsed.imports.length >= 3, "expected at least 3 imports");

    const exportStar = parsed.imports.find((imp) =>
      imp.specifier.endsWith("./foo.js"),
    );
    const exportNamed = parsed.imports.find((imp) =>
      imp.specifier.endsWith("./bar.js"),
    );
    const plainImport = parsed.imports.find((imp) =>
      imp.specifier.endsWith("./utils.js"),
    );

    assert.ok(exportStar, "export * statement should be extracted");
    assert.ok(
      exportNamed,
      "export { named } from statement should be extracted",
    );
    assert.ok(plainImport, "plain import statement should be extracted");

    assert.strictEqual(
      (exportStar as { isReExport: boolean }).isReExport,
      true,
      "`export * from` must set isReExport=true",
    );
    assert.strictEqual(
      (exportNamed as { isReExport: boolean }).isReExport,
      true,
      "`export { x } from` must set isReExport=true",
    );
    assert.strictEqual(
      (plainImport as { isReExport: boolean }).isReExport,
      false,
      "plain import must set isReExport=false",
    );
  });

  it("Python `from x import y as y` is marked as a re-export", () => {
    if (!isRustEngineAvailable()) return;

    const relPath = "src/module.py";
    const absPath = join(tmpDir, relPath);
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    writeFileSync(
      absPath,
      ["from .foo import bar as bar", "from .baz import qux", "import os"].join(
        "\n",
      ),
      "utf8",
    );

    const result = parseFilesRust("test-repo", tmpDir, [
      { path: relPath, size: 0, mtime: Date.now() },
    ]);
    assert.ok(result !== null);
    assert.strictEqual(result.length, 1);
    const parsed = result[0]!;
    assert.ok(!parsed.parseError, `parse should succeed, got: ${parsed.parseError ?? ""}`);

    const reExport = parsed.imports.find((imp) =>
      imp.specifier.includes(".foo"),
    );
    const plain = parsed.imports.find((imp) => imp.specifier.includes(".baz"));
    const stdlib = parsed.imports.find((imp) => imp.specifier === "os");

    assert.ok(reExport, "re-export import should be extracted");
    assert.ok(plain, "plain from-import should be extracted");
    assert.ok(stdlib, "stdlib import should be extracted");

    assert.strictEqual(
      (reExport as { isReExport: boolean }).isReExport,
      true,
      "`from .foo import bar as bar` must set isReExport=true",
    );
    assert.strictEqual(
      (plain as { isReExport: boolean }).isReExport,
      false,
      "`from .baz import qux` must set isReExport=false",
    );
    assert.strictEqual(
      (stdlib as { isReExport: boolean }).isReExport,
      false,
      "`import os` must set isReExport=false",
    );
  });

  it("Rust `pub use foo::bar` is NOT a re-export (matches TS source of truth)", () => {
    if (!isRustEngineAvailable()) return;

    const relPath = "src/lib.rs";
    const absPath = join(tmpDir, relPath);
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    writeFileSync(
      absPath,
      ["pub use foo::bar;", "use baz::qux;", "mod sub;"].join("\n"),
      "utf8",
    );

    const result = parseFilesRust("test-repo", tmpDir, [
      { path: relPath, size: 0, mtime: Date.now() },
    ]);
    assert.ok(result !== null);
    assert.strictEqual(result.length, 1);
    const parsed = result[0]!;
    assert.ok(!parsed.parseError, `parse should succeed, got: ${parsed.parseError ?? ""}`);

    const pubUse = parsed.imports.find((imp) => imp.specifier === "foo::bar");
    const privateUse = parsed.imports.find(
      (imp) => imp.specifier === "baz::qux",
    );

    assert.ok(pubUse, "`pub use` should be extracted");
    assert.ok(privateUse, "`use` should be extracted");

    // Rust/TS parity: src/indexer/adapter/rust.ts hardcodes isReExport=false for
    // `pub use` statements, so the Rust extractor matches by also emitting false.
    assert.strictEqual(
      (pubUse as { isReExport: boolean }).isReExport,
      false,
      "`pub use foo::bar` must set isReExport=false to match TS source of truth",
    );
    assert.strictEqual(
      (privateUse as { isReExport: boolean }).isReExport,
      false,
      "`use baz::qux` must set isReExport=false",
    );
  });

  it('Go `. "fmt"` dot-import is NOT a re-export (matches TS source of truth)', () => {
    if (!isRustEngineAvailable()) return;

    const relPath = "main.go";
    const absPath = join(tmpDir, relPath);
    writeFileSync(
      absPath,
      [
        "package main",
        "",
        "import (",
        '\t. "fmt"',
        '\t"os"',
        ")",
        "",
        "func main() {}",
      ].join("\n"),
      "utf8",
    );

    const result = parseFilesRust("test-repo", tmpDir, [
      { path: relPath, size: 0, mtime: Date.now() },
    ]);
    assert.ok(result !== null);
    assert.strictEqual(result.length, 1);
    const parsed = result[0]!;
    assert.ok(!parsed.parseError, `parse should succeed, got: ${parsed.parseError ?? ""}`);

    const dotImport = parsed.imports.find((imp) => imp.specifier === "fmt");
    const plainImport = parsed.imports.find((imp) => imp.specifier === "os");

    assert.ok(dotImport, "dot-import should be extracted");
    assert.ok(plainImport, "plain import should be extracted");

    // Rust/TS parity: src/indexer/adapter/go.ts hardcodes isReExport=false for
    // dot-imports (they are namespace injections, not JS/TS-style re-exports).
    assert.strictEqual(
      (dotImport as { isReExport: boolean }).isReExport,
      false,
      'Go `. "fmt"` dot-import must set isReExport=false to match TS source of truth',
    );
    assert.strictEqual(
      (plainImport as { isReExport: boolean }).isReExport,
      false,
      '`"os"` must set isReExport=false',
    );
  });
});
