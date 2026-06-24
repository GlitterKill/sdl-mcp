import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  SETUP_WIZARD_EMBEDDING_CHOICES,
  SETUP_WIZARD_LANGUAGE_LABELS,
  shouldRunSetupWizard,
} from "../../dist/cli/setup-wizard/run.js";

test("-y and non-TTY skip the setup wizard", () => {
  assert.equal(shouldRunSetupWizard({ yes: true }, true), false);
  assert.equal(shouldRunSetupWizard({}, false), false);
});

test("normal TTY init runs the setup wizard", () => {
  assert.equal(shouldRunSetupWizard({}, true), true);
});

test("interactive dry-run init still runs the setup wizard", () => {
  assert.equal(shouldRunSetupWizard({ dryRun: true }, true), true);
});

test("postinstall flag still runs only when TTY is available", () => {
  assert.equal(shouldRunSetupWizard({ fromPostinstall: true }, true), true);
  assert.equal(shouldRunSetupWizard({ fromPostinstall: true }, false), false);
});

test("setup wizard uses global mode when launched outside a repo", async () => {
  const root = mkdtempSync(join(tmpdir(), "sdl-init-nonrepo-"));
  try {
    const { detectInitialRepoRoot } = await import("../../dist/cli/commands/init.js");
    assert.equal(detectInitialRepoRoot({}, {}, root), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("setup wizard finds the nearest repo root before scanning languages", async () => {
  const root = mkdtempSync(join(tmpdir(), "sdl-init-repo-"));
  try {
    mkdirSync(join(root, ".git"));
    mkdirSync(join(root, "packages", "app"), { recursive: true });
    const { detectInitialRepoRoot } = await import("../../dist/cli/commands/init.js");

    assert.equal(
      detectInitialRepoRoot({}, {}, join(root, "packages", "app")),
      root,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("explicit repo path is accepted even when cwd is not a repo", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "sdl-init-cwd-"));
  const repo = mkdtempSync(join(tmpdir(), "sdl-init-explicit-"));
  try {
    writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "app" }));
    const { detectInitialRepoRoot } = await import("../../dist/cli/commands/init.js");

    assert.equal(detectInitialRepoRoot({ repoPath: repo }, {}, cwd), repo);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("global resources live under the user SDL-MCP resource directory", async () => {
  const home = join(tmpdir(), "sdl-home");
  const { globalResourceRoot, userAgentConfigRoot } = await import(
    "../../dist/cli/commands/init.js"
  );

  assert.equal(globalResourceRoot(home), join(home, ".sdl-mcp", "resources"));
  assert.equal(userAgentConfigRoot(home), join(home, ".sdl-mcp", "configs"));
});

test("global resource agent configs are created under the resource directory", async () => {
  const { buildGlobalResourceAssets, globalResourceRoot } = await import(
    "../../dist/cli/commands/init.js"
  );
  const root = globalResourceRoot();
  const paths = buildGlobalResourceAssets({
    repoPath: "",
    globalInstall: true,
    languages: ["ts"],
    agents: ["adal", "zencoder"],
    languageProviders: true,
    semanticTier: "code",
    repoSizeProfile: "small",
    paths: {},
    lspManualCommands: [],
    writeConfig: true,
    firstIndex: false,
  }).map((asset) => asset.path);

  assert.ok(paths.includes(join(root, "configs", "adal-mcp-config.json")));
  assert.ok(paths.includes(join(root, "configs", "zencoder-mcp-config.json")));
});

test("global resource rich client configs are created when selected but not detected", async () => {
  const { buildGlobalResourceAssets, globalResourceRoot } = await import(
    "../../dist/cli/commands/init.js"
  );
  const root = globalResourceRoot();
  const paths = buildGlobalResourceAssets({
    repoPath: "",
    globalInstall: true,
    languages: ["ts"],
    agents: ["claude-code", "codex"],
    languageProviders: true,
    semanticTier: "code",
    repoSizeProfile: "small",
    paths: {},
    lspManualCommands: [],
    writeConfig: true,
    firstIndex: false,
  }, []).map((asset) => asset.path);

  assert.ok(paths.includes(join(root, "configs", "codex-mcp-config.json")));
  assert.ok(paths.some((path) => path.endsWith("AGENTS.md")));
  assert.ok(paths.some((path) => path.endsWith("CLAUDE.md")));
});

test("global setup wizard asks for embeddings before writing resources", () => {
  const source = readFileSync("src/cli/setup-wizard/run.ts", "utf8");
  const embeddingsPrompt = source.indexOf('"Embeddings"');
  const globalWritePrompt = source.indexOf('"Write global resources now?"');

  assert.ok(embeddingsPrompt >= 0, "wizard should show an Embeddings choice");
  assert.ok(
    embeddingsPrompt < globalWritePrompt,
    "Embeddings must be selected before global install can return",
  );
});

test("embedding option descriptions are always visible in labels", () => {
  assert.deepEqual(
    SETUP_WIZARD_EMBEDDING_CHOICES.map((choice) => choice.label),
    [
      "Code (Jina symbol embeddings, no file summaries)",
      "Enhanced (Jina symbol embeddings and Nomic file summaries)",
      "Off (Disable semantic embeddings)",
    ],
  );
  assert.ok(SETUP_WIZARD_EMBEDDING_CHOICES.every((choice) => !choice.hint));
});

test("init language validation includes supported provider languages only", async () => {
  const { VALID_LANGUAGES } = await import("../../dist/cli/commands/init.js");

  assert.ok(VALID_LANGUAGES.includes("haskell"));
  assert.ok(VALID_LANGUAGES.includes("fsharp"));
  assert.ok(VALID_LANGUAGES.includes("zig"));
  assert.equal(VALID_LANGUAGES.includes("not-a-language"), false);
});

test("setup wizard labels JSX variants by file extension", () => {
  assert.equal(SETUP_WIZARD_LANGUAGE_LABELS.ts, "TypeScript");
  assert.equal(SETUP_WIZARD_LANGUAGE_LABELS.tsx, "TSX (.tsx)");
  assert.equal(SETUP_WIZARD_LANGUAGE_LABELS.js, "JavaScript");
  assert.equal(SETUP_WIZARD_LANGUAGE_LABELS.jsx, "JSX (.jsx)");
});

test("generic agent dry-run assets go to user config snippets without duplicating rich clients", async () => {
  const root = mkdtempSync(join(tmpdir(), "sdl-init-agent-assets-"));
  const configPath = join(root, "sdlmcp.config.json");
  const repo = join(root, "repo");
  try {
    mkdirSync(repo);
    writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "agent-assets" }));
    const { spawnSync } = await import("node:child_process");
    const result = spawnSync(
      process.execPath,
      [
        "dist/cli/index.js",
        "init",
        "--dry-run",
        "--config",
        configPath,
        "--repo-path",
        repo,
        "--agents",
        "claude-code,codex,promptscript",
      ],
      { cwd: process.cwd(), encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /AGENTS\.md/);
    assert.match(result.stdout, /CLAUDE\.md/);
    assert.match(result.stdout, /CODEX\.md/);
    assert.match(result.stdout, /promptscript-mcp-config\.json/);
    assert.doesNotMatch(result.stdout, /configs\/codex-mcp-config\.json/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
