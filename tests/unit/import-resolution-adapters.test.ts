import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { resolveImportCandidatePaths } from "../../src/indexer/import-resolution/registry.js";

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
