import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { resolveImportCandidatePaths } from "../../dist/indexer/import-resolution/registry.js";

const tempDirs: string[] = [];

function createTempRepo(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeRepoFile(repoRoot: string, relPath: string, content = ""): void {
  const fullPath = join(repoRoot, relPath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content, "utf8");
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("import-resolution adapters", () => {
  it("resolves Go module imports through go.mod", async () => {
    const repoRoot = createTempRepo("sdl-go-imports-");
    writeRepoFile(repoRoot, "go.mod", "module github.com/acme/project\n");
    writeRepoFile(repoRoot, "pkg/service/service.go", "package service\n");

    const paths = await resolveImportCandidatePaths({
      language: "go",
      repoRoot,
      importerRelPath: "cmd/api/main.go",
      specifier: "github.com/acme/project/pkg/service",
      extensions: [".go"],
    });

    assert.deepStrictEqual(paths, ["pkg/service/service.go"]);
  });

  it("resolves Go imports from indexed paths without source files on disk", async () => {
    const repoRoot = createTempRepo("sdl-go-indexed-imports-");
    writeRepoFile(repoRoot, "go.mod", "module github.com/acme/project\n");

    const paths = await resolveImportCandidatePaths({
      language: "go",
      repoRoot,
      importerRelPath: "cmd/api/main.go",
      specifier: "github.com/acme/project/pkg/service",
      extensions: [".go"],
      knownRepoPaths: new Map([["pkg/service/service.go", true]]),
    });

    assert.deepStrictEqual(paths, ["pkg/service/service.go"]);
  });

  it("applies configured ignores to uncached Go package walks", async () => {
    const repoRoot = createTempRepo("sdl-go-ignored-imports-");
    writeRepoFile(repoRoot, "go.mod", "module github.com/acme/project\n");
    writeRepoFile(repoRoot, "pkg/service/impl/service.go");
    writeRepoFile(repoRoot, "pkg/service/vendor/impl/service.go");

    const paths = await resolveImportCandidatePaths({
      language: "go",
      repoRoot,
      importerRelPath: "cmd/api/main.go",
      specifier: "github.com/acme/project/pkg/service",
      extensions: [".go"],
      ignorePatterns: ["**/vendor/**"],
    });

    assert.deepStrictEqual(paths, ["pkg/service/impl/service.go"]);
  });

  it("resolves Java package imports to source files", async () => {
    const repoRoot = createTempRepo("sdl-java-imports-");
    writeRepoFile(
      repoRoot,
      "src/main/java/com/example/service/Helper.java",
      "package com.example.service;",
    );

    const paths = await resolveImportCandidatePaths({
      language: "java",
      repoRoot,
      importerRelPath: "src/main/java/com/example/app/App.java",
      specifier: "com.example.service.Helper",
      extensions: [".java"],
    });

    assert.deepStrictEqual(paths, [
      "src/main/java/com/example/service/Helper.java",
    ]);
  });

  it("resolves Java imports from indexed paths without source files on disk", async () => {
    const repoRoot = createTempRepo("sdl-java-indexed-imports-");

    const paths = await resolveImportCandidatePaths({
      language: "java",
      repoRoot,
      importerRelPath: "src/main/java/com/example/app/App.java",
      specifier: "com.example.service.Helper",
      extensions: [".java"],
      knownRepoPaths: new Map([
        ["src/generated/com/example/service/Helper.java", true],
      ]),
    });

    assert.deepStrictEqual(paths, [
      "src/generated/com/example/service/Helper.java",
    ]);
  });

  it("applies configured ignores to uncached Java package walks", async () => {
    const repoRoot = createTempRepo("sdl-java-ignored-imports-");
    writeRepoFile(
      repoRoot,
      "src/generated/com/example/service/Helper.java",
    );
    writeRepoFile(
      repoRoot,
      "vendor/generated/com/example/service/Helper.java",
    );

    const paths = await resolveImportCandidatePaths({
      language: "java",
      repoRoot,
      importerRelPath: "src/main/java/com/example/app/App.java",
      specifier: "com.example.service.Helper",
      extensions: [".java"],
      ignorePatterns: ["**/vendor/**"],
    });

    assert.deepStrictEqual(paths, [
      "src/generated/com/example/service/Helper.java",
    ]);
  });

  it("resolves Kotlin imports from indexed paths without source files on disk", async () => {
    const repoRoot = createTempRepo("sdl-kotlin-indexed-imports-");

    const paths = await resolveImportCandidatePaths({
      language: "kotlin",
      repoRoot,
      importerRelPath: "src/main/kotlin/com/example/app/App.kt",
      specifier: "com.example.service.Helper",
      extensions: [".kt"],
      knownRepoPaths: new Map([
        ["src/generated/com/example/service/Helper.kt", true],
      ]),
    });

    assert.deepStrictEqual(paths, [
      "src/generated/com/example/service/Helper.kt",
    ]);
  });

  it("resolves Rust crate imports to module files", async () => {
    const repoRoot = createTempRepo("sdl-rust-imports-");
    writeRepoFile(repoRoot, "src/lib.rs", "pub mod services;");
    writeRepoFile(
      repoRoot,
      "src/services/email.rs",
      "pub struct EmailService;",
    );

    const paths = await resolveImportCandidatePaths({
      language: "rust",
      repoRoot,
      importerRelPath: "src/controllers/api.rs",
      specifier: "crate::services::email::EmailService",
      extensions: [".rs"],
    });

    assert.deepStrictEqual(paths, ["src/services/email.rs"]);
  });

  it("resolves Python relative imports with dot prefixes", async () => {
    const repoRoot = createTempRepo("sdl-python-imports-");
    writeRepoFile(
      repoRoot,
      "pkg/api/handler.py",
      "from ..utils import helpers\n",
    );
    writeRepoFile(
      repoRoot,
      "pkg/utils/helpers.py",
      "def helper():\n  return True\n",
    );

    const paths = await resolveImportCandidatePaths({
      language: "python",
      repoRoot,
      importerRelPath: "pkg/api/handler.py",
      specifier: "..utils.helpers",
      extensions: [".py"],
    });

    assert.deepStrictEqual(paths, ["pkg/utils/helpers.py"]);
  });

  it("resolves Python absolute imports to package modules", async () => {
    const repoRoot = createTempRepo("sdl-python-imports-");
    writeRepoFile(
      repoRoot,
      "mypackage/core/engine.py",
      "def run():\n  return 1\n",
    );

    const paths = await resolveImportCandidatePaths({
      language: "python",
      repoRoot,
      importerRelPath: "mypackage/app/main.py",
      specifier: "mypackage.core.engine",
      extensions: [".py"],
    });

    assert.deepStrictEqual(paths, ["mypackage/core/engine.py"]);
  });

  it("resolves C# namespace imports to matching source files", async () => {
    const repoRoot = createTempRepo("sdl-csharp-imports-");
    writeRepoFile(
      repoRoot,
      "MyApp/Services/UserService.cs",
      "namespace MyApp.Services;\n",
    );

    const paths = await resolveImportCandidatePaths({
      language: "csharp",
      repoRoot,
      importerRelPath: "MyApp/Controllers/UserController.cs",
      specifier: "MyApp.Services.UserService",
      extensions: [".cs"],
    });

    assert.deepStrictEqual(paths, ["MyApp/Services/UserService.cs"]);
  });

  it("resolves C# namespace imports via type-name fallback search", async () => {
    const repoRoot = createTempRepo("sdl-csharp-imports-");
    writeRepoFile(
      repoRoot,
      "src/Generated/UserService.cs",
      "namespace Acme.Generated;\n",
    );

    const paths = await resolveImportCandidatePaths({
      language: "csharp",
      repoRoot,
      importerRelPath: "src/App/Controllers/UserController.cs",
      specifier: "Acme.Services.UserService",
      extensions: [".cs"],
    });

    assert.deepStrictEqual(paths, ["src/Generated/UserService.cs"]);
  });

  it("resolves C# fallback imports from indexed paths without source files on disk", async () => {
    const repoRoot = createTempRepo("sdl-csharp-indexed-imports-");

    const paths = await resolveImportCandidatePaths({
      language: "csharp",
      repoRoot,
      importerRelPath: "src/App/Controllers/UserController.cs",
      specifier: "Acme.Services.UserService",
      extensions: [".cs"],
      knownRepoPaths: new Map([["src/Generated/UserService.cs", true]]),
    });

    assert.deepStrictEqual(paths, ["src/Generated/UserService.cs"]);
  });

  it("treats indexed C# paths as authoritative and ignores uncached disk targets", async () => {
    const repoRoot = createTempRepo("sdl-csharp-indexed-imports-");
    writeRepoFile(repoRoot, "Acme/Services/UserService.cs");

    const paths = await resolveImportCandidatePaths({
      language: "csharp",
      repoRoot,
      importerRelPath: "src/App/Controllers/UserController.cs",
      specifier: "Acme.Services.UserService",
      extensions: [".cs"],
      knownRepoPaths: new Map(),
    });

    assert.deepStrictEqual(paths, []);
  });

  it("honors ignore patterns for direct and fallback C# candidates", async () => {
    const repoRoot = createTempRepo("sdl-csharp-ignored-imports-");
    writeRepoFile(repoRoot, "Acme/Services/UserService.cs");
    writeRepoFile(repoRoot, "src/Generated/UserService.cs");
    writeRepoFile(repoRoot, "vendor/Generated/UserService.cs");

    const paths = await resolveImportCandidatePaths({
      language: "csharp",
      repoRoot,
      importerRelPath: "src/App/Controllers/UserController.cs",
      specifier: "Acme.Services.UserService",
      extensions: [".cs"],
      ignorePatterns: ["**/Acme/Services/**", "**/vendor/**"],
    });

    assert.deepStrictEqual(paths, ["src/Generated/UserService.cs"]);
  });

  it("resolves C local include to relative path", async () => {
    const repoRoot = createTempRepo("sdl-c-includes-");
    writeRepoFile(
      repoRoot,
      "src/utils.h",
      "#ifndef UTILS_H\n#define UTILS_H\nint helper(void);\n#endif\n",
    );

    const paths = await resolveImportCandidatePaths({
      language: "c",
      repoRoot,
      importerRelPath: "src/main.c",
      specifier: "utils.h",
      extensions: [".c", ".h"],
    });

    assert.deepStrictEqual(paths, ["src/utils.h"]);
  });

  it("resolves C includes through known repo paths when provided", async () => {
    const repoRoot = createTempRepo("sdl-c-known-includes-");

    const paths = await resolveImportCandidatePaths({
      language: "c",
      repoRoot,
      importerRelPath: "src/main.c",
      specifier: "utils.h",
      extensions: [".c", ".h"],
      knownRepoPaths: new Map([["src/utils.h", true]]),
    });

    assert.deepStrictEqual(paths, ["src/utils.h"]);
  });

  it("does not fall back to filesystem checks when known repo paths are provided", async () => {
    const repoRoot = createTempRepo("sdl-c-known-includes-");
    writeRepoFile(repoRoot, "src/utils.h", "int helper(void);");

    const paths = await resolveImportCandidatePaths({
      language: "c",
      repoRoot,
      importerRelPath: "src/main.c",
      specifier: "utils.h",
      extensions: [".c", ".h"],
      knownRepoPaths: new Map(),
    });

    assert.deepStrictEqual(paths, []);
  });

  it("resolves C include with subdirectory path", async () => {
    const repoRoot = createTempRepo("sdl-c-includes-");
    writeRepoFile(repoRoot, "include/mylib/core.h", "");

    const paths = await resolveImportCandidatePaths({
      language: "c",
      repoRoot,
      importerRelPath: "src/main.c",
      specifier: "mylib/core.h",
      extensions: [".c", ".h"],
    });

    assert.deepStrictEqual(paths, ["include/mylib/core.h"]);
  });

  it("resolves C++ local include identically to C", async () => {
    const repoRoot = createTempRepo("sdl-cpp-includes-");
    writeRepoFile(repoRoot, "src/widget.hpp", "class Widget {};");

    const paths = await resolveImportCandidatePaths({
      language: "cpp",
      repoRoot,
      importerRelPath: "src/main.cpp",
      specifier: "widget.hpp",
      extensions: [".cpp", ".hpp", ".cc", ".cxx", ".hxx", ".h"],
    });

    assert.deepStrictEqual(paths, ["src/widget.hpp"]);
  });

  it("resolves include relative to repo root when not near importer", async () => {
    const repoRoot = createTempRepo("sdl-c-includes-");
    writeRepoFile(repoRoot, "lib/helpers.h", "void help(void);");

    const paths = await resolveImportCandidatePaths({
      language: "c",
      repoRoot,
      importerRelPath: "src/app/main.c",
      specifier: "lib/helpers.h",
      extensions: [".c", ".h"],
    });

    assert.deepStrictEqual(paths, ["lib/helpers.h"]);
  });

  it("resolves Shell source path relative to importer", async () => {
    const repoRoot = createTempRepo("sdl-shell-imports-");
    writeRepoFile(repoRoot, "lib/utils.sh", 'log_info() { echo "$1"; }');

    const paths = await resolveImportCandidatePaths({
      language: "shell",
      repoRoot,
      importerRelPath: "scripts/deploy.sh",
      specifier: "../lib/utils.sh",
      extensions: [".sh", ".bash"],
    });

    assert.deepStrictEqual(paths, ["lib/utils.sh"]);
  });

  it("resolves Shell source path relative to repo root", async () => {
    const repoRoot = createTempRepo("sdl-shell-imports-");
    writeRepoFile(repoRoot, "lib/common.sh", "setup() { true; }");

    const paths = await resolveImportCandidatePaths({
      language: "shell",
      repoRoot,
      importerRelPath: "scripts/deploy.sh",
      specifier: "lib/common.sh",
      extensions: [".sh", ".bash"],
    });

    assert.deepStrictEqual(paths, ["lib/common.sh"]);
  });

  it("resolves Shell source with extension fallback", async () => {
    const repoRoot = createTempRepo("sdl-shell-imports-");
    writeRepoFile(repoRoot, "lib/helpers.sh", "helper() { true; }");

    const paths = await resolveImportCandidatePaths({
      language: "shell",
      repoRoot,
      importerRelPath: "scripts/main.sh",
      specifier: "lib/helpers",
      extensions: [".sh", ".bash"],
    });

    assert.deepStrictEqual(paths, ["lib/helpers.sh"]);
  });

  it("resolves PHP namespace imports via composer PSR-4", async () => {
    const repoRoot = createTempRepo("sdl-php-imports-");
    writeRepoFile(
      repoRoot,
      "composer.json",
      JSON.stringify({
        autoload: {
          "psr-4": {
            "App\\\\": "app/",
          },
        },
      }),
    );
    writeRepoFile(repoRoot, "app/Services/EmailService.php", "<?php\n");

    const paths = await resolveImportCandidatePaths({
      language: "php",
      repoRoot,
      importerRelPath: "app/Http/Controllers/UserController.php",
      specifier: "App\\\\Services\\\\EmailService",
      extensions: [".php"],
    });

    assert.deepStrictEqual(paths, ["app/Services/EmailService.php"]);
  });
});
