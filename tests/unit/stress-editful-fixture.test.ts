import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  buildStressFixtureEditContent,
  createStressFixtureEditSession,
  STRESS_EDITFUL_BLOCK_END,
  STRESS_EDITFUL_BLOCK_START,
  STRESS_EDITFUL_TARGET_REL_PATH,
  stripStressFixtureEditBlock,
} from "../stress/infra/scenario-setup.ts";

describe("stress editful fixture helpers", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("replaces any prior managed edit block when building content", () => {
    const base = "export function clamp(value: number): number {\n  return value;\n}\n";
    const first = buildStressFixtureEditContent(base, 1);
    const second = buildStressFixtureEditContent(first, 2);

    assert.match(second, /__stressEditMarker2/);
    assert.doesNotMatch(second, /__stressEditMarker1/);
    assert.equal(
      second.split(STRESS_EDITFUL_BLOCK_START).length - 1,
      1,
    );
    assert.equal(
      second.split(STRESS_EDITFUL_BLOCK_END).length - 1,
      1,
    );
  });

  it("restores the normalized fixture content after applying an edit", async () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), "sdl-stress-editful-"));
    tempDirs.push(fixtureDir);

    const targetPath = join(fixtureDir, STRESS_EDITFUL_TARGET_REL_PATH);
    mkdirSync(dirname(targetPath), { recursive: true });
    const baseContent =
      "export function truncate(value: string): string {\n  return value;\n}\n";
    writeFileSync(targetPath, baseContent, "utf8");

    const session = await createStressFixtureEditSession(fixtureDir);
    await session.applyIteration(3);

    const editedContent = readFileSync(targetPath, "utf8");
    assert.match(editedContent, /__stressEditMarker3/);

    await session.restore();

    assert.equal(readFileSync(targetPath, "utf8"), baseContent);
  });

  it("normalizes a previously crashed managed edit on restore", async () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), "sdl-stress-editful-"));
    tempDirs.push(fixtureDir);

    const targetPath = join(fixtureDir, STRESS_EDITFUL_TARGET_REL_PATH);
    mkdirSync(dirname(targetPath), { recursive: true });
    const baseContent =
      "export function slugify(value: string): string {\n  return value;\n}\n";
    const crashedContent = buildStressFixtureEditContent(baseContent, 1);
    writeFileSync(targetPath, crashedContent, "utf8");

    const session = await createStressFixtureEditSession(fixtureDir);
    await session.restore();

    const restoredContent = readFileSync(targetPath, "utf8");
    assert.equal(restoredContent, stripStressFixtureEditBlock(crashedContent));
    assert.doesNotMatch(restoredContent, /__stressEditMarker1/);
  });
});
