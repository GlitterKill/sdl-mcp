import assert from "node:assert";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, beforeEach, afterEach } from "node:test";

import { detectInstalledClients } from "../../dist/cli/commands/init.js";

describe("detectInstalledClients — CLAUDE_CONFIG_DIR (issue #17)", () => {
  let fakeHome: string;
  let originalUserProfile: string | undefined;
  let originalAppData: string | undefined;
  let originalClaudeConfigDir: string | undefined;

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), "sdl-init-home-"));
    originalUserProfile = process.env.USERPROFILE;
    originalAppData = process.env.APPDATA;
    originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.USERPROFILE = fakeHome;
    // Point APPDATA somewhere harmless so Claude Desktop config doesn't accidentally hit.
    process.env.APPDATA = join(fakeHome, "appdata-empty");
    delete process.env.CLAUDE_CONFIG_DIR;
  });

  afterEach(() => {
    if (originalUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = originalUserProfile;
    }
    if (originalAppData === undefined) {
      delete process.env.APPDATA;
    } else {
      process.env.APPDATA = originalAppData;
    }
    if (originalClaudeConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
    }
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it("detects Claude Code at $CLAUDE_CONFIG_DIR/settings.json when env var is set", () => {
    const customDir = join(fakeHome, "custom-claude");
    mkdirSync(customDir, { recursive: true });
    const settingsPath = join(customDir, "settings.json");
    writeFileSync(settingsPath, "{}", "utf8");
    process.env.CLAUDE_CONFIG_DIR = customDir;

    const detections = detectInstalledClients();
    const claude = detections.find((d) => d.name === "claude-code");
    assert.ok(claude, "expected claude-code detection");
    assert.ok(
      claude.configPath.endsWith("custom-claude/settings.json") ||
        claude.configPath.endsWith("custom-claude\\settings.json"),
      `expected configPath inside CLAUDE_CONFIG_DIR, got ${claude.configPath}`,
    );
  });

  it("falls back to ~/.claude/settings.json when CLAUDE_CONFIG_DIR is unset", () => {
    const legacyDir = join(fakeHome, ".claude");
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, "settings.json"), "{}", "utf8");

    const detections = detectInstalledClients();
    const claude = detections.find((d) => d.name === "claude-code");
    assert.ok(claude, "expected claude-code detection");
    assert.ok(
      claude.configPath.endsWith(".claude/settings.json") ||
        claude.configPath.endsWith(".claude\\settings.json"),
      `expected configPath at legacy ~/.claude/settings.json, got ${claude.configPath}`,
    );
  });

  it("env var is authoritative — does NOT fall through to legacy when env-var location is empty", () => {
    // CLAUDE_CONFIG_DIR set but empty; legacy ~/.claude/settings.json exists.
    // Authoritative behavior: synthesize a phantom hit pointing at the env-var
    // location so install instructions steer the user to where Claude Code will
    // actually read from, instead of recommending the legacy path.
    const customDir = join(fakeHome, "custom-claude-empty");
    mkdirSync(customDir, { recursive: true });
    const legacyDir = join(fakeHome, ".claude");
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, "settings.json"), "{}", "utf8");

    process.env.CLAUDE_CONFIG_DIR = customDir;

    const detections = detectInstalledClients();
    const claude = detections.find((d) => d.name === "claude-code");
    assert.ok(claude, "expected claude-code detection (synthesized)");
    assert.ok(
      claude.configPath.endsWith("custom-claude-empty/settings.json") ||
        claude.configPath.endsWith("custom-claude-empty\\settings.json"),
      `expected env-var location (not legacy), got ${claude.configPath}`,
    );
    // Also ensure we did NOT pick the legacy file.
    assert.ok(
      !/[/\\]\.claude[/\\]settings\.json$/.test(claude.configPath),
      `expected NOT legacy ~/.claude/settings.json, got ${claude.configPath}`,
    );
  });

  it("synthesizes a hit when env var is set and nothing exists yet", () => {
    // Fresh install: env var set, neither env-var nor legacy paths populated.
    // Detection must still surface the env-var location so install instructions
    // do not silently fall back to manual-config or legacy paths.
    const customDir = join(fakeHome, "fresh-custom-claude");
    process.env.CLAUDE_CONFIG_DIR = customDir;
    // Note: customDir does NOT exist on disk yet.

    const detections = detectInstalledClients();
    const claude = detections.find((d) => d.name === "claude-code");
    assert.ok(claude, "expected synthesized claude-code detection");
    assert.ok(
      claude.configPath.includes("fresh-custom-claude"),
      `expected configPath to point at env-var location, got ${claude.configPath}`,
    );
  });

  it("supports comma-separated CLAUDE_CONFIG_DIR — first dir wins for synthesized target", () => {
    const dirA = join(fakeHome, "claude-a");
    const dirB = join(fakeHome, "claude-b");
    mkdirSync(dirB, { recursive: true });
    writeFileSync(join(dirB, "settings.json"), "{}", "utf8");
    // Env var lists A first; A is empty, B has settings.json. Detection should
    // find B (env-var-list iteration finds the first existing match).
    process.env.CLAUDE_CONFIG_DIR = `${dirA},${dirB}`;

    const detections = detectInstalledClients();
    const claude = detections.find((d) => d.name === "claude-code");
    assert.ok(claude, "expected claude-code detection");
    assert.ok(
      claude.configPath.includes("claude-b"),
      `expected to find existing config in second dir, got ${claude.configPath}`,
    );
  });

  it("supports comma-separated CLAUDE_CONFIG_DIR — synthesizes first dir when none populated", () => {
    const dirA = join(fakeHome, "first-claude");
    const dirB = join(fakeHome, "second-claude");
    process.env.CLAUDE_CONFIG_DIR = `${dirA}, ${dirB}`;

    const detections = detectInstalledClients();
    const claude = detections.find((d) => d.name === "claude-code");
    assert.ok(claude, "expected synthesized claude-code detection");
    assert.ok(
      claude.configPath.includes("first-claude"),
      `expected first listed dir to be synthesis target, got ${claude.configPath}`,
    );
  });
});
