import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";

import * as releaseNotesModule from "../../scripts/build-release-notes.mjs";
import {
  buildReleaseNotes,
  extractVersionSection,
  readReleaseInventory,
  validateReleaseNoteCoverage,
} from "../../scripts/build-release-notes.mjs";

const OID_A = "a".repeat(40);
const OID_B = "b".repeat(40);
const OID_C = "c".repeat(40);
const OID_D = "d".repeat(40);
const BASE_OID = "0".repeat(40);
const SCRIPT_PATH = resolve("scripts/build-release-notes.mjs");
const PREPARE_RELEASE_SCRIPT_PATH = resolve("scripts/prepare-release.mjs");
const RELEASE_TEST_DOC_PATH = resolve("docs/release-test.md");

function git(cwd: string, args: string[], options: { input?: string } = {}) {
  return execFileSync(
    "git",
    ["-c", "commit.gpgsign=false", ...args],
    {
      cwd,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      ...options,
    },
  ).trim();
}

function makeRepo(t: { after: (fn: () => void) => void }) {
  const cwd = mkdtempSync(join(tmpdir(), "sdl-release-notes-"));
  t.after(() => rmSync(cwd, { force: true, recursive: true }));
  git(cwd, ["init", "-b", "main"]);
  git(cwd, ["config", "user.email", "release-notes@example.test"]);
  git(cwd, ["config", "user.name", "Release Notes Test"]);
  return cwd;
}

function commitFile(cwd: string, path: string, content: string, subject: string) {
  const absolutePath = join(cwd, path);
  mkdirSync(resolve(absolutePath, ".."), { recursive: true });
  writeFileSync(absolutePath, content);
  git(cwd, ["add", "--", path]);
  git(cwd, ["commit", "-m", subject]);
  return git(cwd, ["rev-parse", "HEAD"]);
}

function commitEntry(
  oid: string,
  {
    parents = [BASE_OID],
    paths = ["src/example.ts"],
    subject = `work ${oid[0]}`,
  }: { parents?: string[]; paths?: string[]; subject?: string } = {},
) {
  return { oid, parents, paths, subject };
}

function inventory(
  commits: ReturnType<typeof commitEntry>[],
  targetOid = commits.at(-1)?.oid ?? BASE_OID,
) {
  return { baseOid: BASE_OID, targetOid, commits };
}

function section(markerLines: string, version = "1.2.3") {
  return [
    "# Changelog",
    "",
    `## [${version}] - 2026-08-25`,
    "",
    "### Added",
    "",
    "- **Grouped work**: A concise summary.",
    markerLines,
    "",
    "## [1.2.2] - 2026-08-24",
    "",
    "- Older work.",
    "",
  ].join("\n");
}

function validIncludedMarkdown(oids = [OID_A, OID_B]) {
  return section(`  <!-- release-note-commits: ${oids.join(" ")} -->`);
}

function makeTaggedReleaseRepo(t: { after: (fn: () => void) => void }) {
  const cwd = makeRepo(t);
  commitFile(cwd, "README.md", "base\n", "base");
  git(cwd, ["tag", "-a", "v1.0.0", "-m", "v1.0.0"]);

  const workOid = commitFile(cwd, "src/work.ts", "export const work = true;\n", "feat: work");
  const changelog = [
    "# Changelog",
    "",
    "## [1.1.0] - 2026-08-25",
    "",
    "### Added",
    "",
    "- **Work**: Added the work.",
    `  <!-- release-note-commits: ${workOid} -->`,
    "",
    "## [1.0.0] - 2026-08-24",
    "",
    "- Initial release.",
    "",
  ].join("\n");
  writeFileSync(join(cwd, "CHANGELOG.md"), changelog);
  writeFileSync(join(cwd, "package.json"), '{"version":"1.1.0"}\n');
  git(cwd, ["add", "CHANGELOG.md", "package.json"]);
  git(cwd, ["commit", "-m", "chore: release v1.1.0"]);
  const releaseOid = git(cwd, ["rev-parse", "HEAD"]);
  git(cwd, ["tag", "-a", "v1.1.0", "-m", "v1.1.0"]);
  return { cwd, workOid, releaseOid, changelog };
}

function makePreReleaseRepo(t: { after: (fn: () => void) => void }) {
  const cwd = makeRepo(t);
  commitFile(cwd, "README.md", "base\n", "base");
  git(cwd, ["tag", "-a", "v1.0.0", "-m", "v1.0.0"]);
  const workOid = commitFile(cwd, "src/work.ts", "export const work = true;\n", "feat: work");
  writeFileSync(
    join(cwd, "CHANGELOG.md"),
    [
      "# Changelog",
      "",
      "## [1.1.0] - 2026-08-25",
      "",
      "- **Work**: Added the work.",
      `  <!-- release-note-commits: ${workOid} -->`,
      "",
    ].join("\n"),
  );
  return { cwd, workOid };
}

describe("module surface", () => {
  it("exports only the four approved release-note functions", () => {
    assert.deepStrictEqual(Object.keys(releaseNotesModule).sort(), [
      "buildReleaseNotes",
      "extractVersionSection",
      "readReleaseInventory",
      "validateReleaseNoteCoverage",
    ]);
  });
});

describe("extractVersionSection", () => {
  it("extracts only the exact requested version section", () => {
    assert.strictEqual(
      extractVersionSection(validIncludedMarkdown(), "1.2.3"),
      [
        "## [1.2.3] - 2026-08-25",
        "",
        "### Added",
        "",
        "- **Grouped work**: A concise summary.",
        `  <!-- release-note-commits: ${OID_A} ${OID_B} -->`,
      ].join("\n"),
    );
  });

  it("rejects missing and duplicate exact version sections", () => {
    assert.throws(
      () => extractVersionSection("# Changelog\n", "1.2.3"),
      /exactly one.*1\.2\.3/i,
    );
    assert.throws(
      () =>
        extractVersionSection(
          `## [1.2.3]\n- One\n\n## [1.2.3] - 2026-08-25\n- Two\n`,
          "1.2.3",
        ),
      /exactly one.*1\.2\.3/i,
    );
  });
});

describe("validateReleaseNoteCoverage", () => {
  it("allows one visible summary bullet to cover multiple commits", () => {
    const result = validateReleaseNoteCoverage({
      markdown: validIncludedMarkdown(),
      version: "1.2.3",
      inventory: inventory([
        commitEntry(OID_A),
        commitEntry(OID_B, { parents: [OID_A] }),
      ]),
    });

    assert.strictEqual(result.preReleaseTargetOid, OID_B);
    assert.match(result.section, /Grouped work/);
  });

  it("rejects missing commit IDs", () => {
    assert.throws(
      () =>
        validateReleaseNoteCoverage({
          markdown: validIncludedMarkdown([OID_A]),
          version: "1.2.3",
          inventory: inventory([
            commitEntry(OID_A),
            commitEntry(OID_B, { parents: [OID_A] }),
          ]),
        }),
      /missing.*bbbb/i,
    );
  });

  it("rejects duplicate commit IDs", () => {
    const markdown = section(
      [
        `  <!-- release-note-commits: ${OID_A} -->`,
        "- **Second summary**: Duplicate assignment.",
        `  <!-- release-note-commits: ${OID_A} -->`,
      ].join("\n"),
    );
    assert.throws(
      () =>
        validateReleaseNoteCoverage({
          markdown,
          version: "1.2.3",
          inventory: inventory([commitEntry(OID_A)]),
        }),
      /duplicate.*aaaa/i,
    );
  });

  it("rejects unknown and abbreviated commit IDs", () => {
    assert.throws(
      () =>
        validateReleaseNoteCoverage({
          markdown: validIncludedMarkdown([OID_D]),
          version: "1.2.3",
          inventory: inventory([commitEntry(OID_A)]),
        }),
      /unknown.*dddd/i,
    );
    assert.throws(
      () =>
        validateReleaseNoteCoverage({
          markdown: section("  <!-- release-note-commits: aaaaaaa -->"),
          version: "1.2.3",
          inventory: inventory([commitEntry(OID_A)]),
        }),
      /malformed.*release-note-commits/i,
    );
  });

  it("rejects include-plus-omit assignments", () => {
    const markdown = section(
      [
        `  <!-- release-note-commits: ${OID_C} -->`,
        `<!-- release-note-omit: ${OID_C} merge-only -->`,
      ].join("\n"),
    );
    assert.throws(
      () =>
        validateReleaseNoteCoverage({
          markdown,
          version: "1.2.3",
          inventory: inventory([
            commitEntry(OID_C, { parents: [OID_A, OID_B] }),
          ]),
        }),
      /both included and omitted.*cccc/i,
    );
  });

  it("rejects malformed, orphaned, and non-adjacent include markers", () => {
    assert.throws(
      () =>
        validateReleaseNoteCoverage({
          markdown: section(`<!-- release-note-commits: ${OID_A} -->`),
          version: "1.2.3",
          inventory: inventory([commitEntry(OID_A)]),
        }),
      /malformed.*release-note-commits/i,
    );
    assert.throws(
      () =>
        validateReleaseNoteCoverage({
          markdown: section(
            `### Changed\n  <!-- release-note-commits: ${OID_A} -->`,
          ),
          version: "1.2.3",
          inventory: inventory([commitEntry(OID_A)]),
        }),
      /orphaned.*release-note-commits/i,
    );
    assert.throws(
      () =>
        validateReleaseNoteCoverage({
          markdown: section(
            `\n  <!-- release-note-commits: ${OID_A} -->`,
          ),
          version: "1.2.3",
          inventory: inventory([commitEntry(OID_A)]),
        }),
      /orphaned.*release-note-commits/i,
    );
  });

  it("rejects markers outside the requested version section", () => {
    const markdown = [
      `## [1.2.4]\n- Future\n  <!-- release-note-commits: ${OID_B} -->`,
      validIncludedMarkdown([OID_A]),
    ].join("\n\n");
    assert.throws(
      () =>
        validateReleaseNoteCoverage({
          markdown,
          version: "1.2.3",
          inventory: inventory([commitEntry(OID_A)]),
        }),
      /outside.*1\.2\.3/i,
    );
  });

  it("accepts merge-only only for a commit with multiple parents", () => {
    const markdown = section(
      [
        `  <!-- release-note-commits: ${OID_A} -->`,
        `<!-- release-note-omit: ${OID_C} merge-only -->`,
      ].join("\n"),
    );
    const result = validateReleaseNoteCoverage({
      markdown,
      version: "1.2.3",
      inventory: inventory([
        commitEntry(OID_A),
        commitEntry(OID_C, { parents: [OID_A, OID_B] }),
      ]),
    });
    assert.strictEqual(result.preReleaseTargetOid, OID_C);

    assert.throws(
      () =>
        validateReleaseNoteCoverage({
          markdown,
          version: "1.2.3",
          inventory: inventory([
            commitEntry(OID_A),
            commitEntry(OID_C, { parents: [OID_A] }),
          ]),
        }),
      /merge-only.*multiple parents/i,
    );
  });

  it("rejects invalid omission codes and abbreviated omission hashes", () => {
    assert.throws(
      () =>
        validateReleaseNoteCoverage({
          markdown: section(
            `<!-- release-note-omit: ${OID_A} release-chore -->`,
          ),
          version: "1.2.3",
          inventory: inventory([commitEntry(OID_A)]),
        }),
      /invalid.*omission code/i,
    );
    assert.throws(
      () =>
        validateReleaseNoteCoverage({
          markdown: section(
            "<!-- release-note-omit: aaaaaaa merge-only -->",
          ),
          version: "1.2.3",
          inventory: inventory([commitEntry(OID_A)]),
        }),
      /malformed.*release-note-omit/i,
    );
  });

  it("allows the exact implicit final release commit", () => {
    const result = validateReleaseNoteCoverage({
      markdown: validIncludedMarkdown([OID_A]),
      version: "1.2.3",
      inventory: inventory(
        [
          commitEntry(OID_A),
          commitEntry(OID_D, {
            parents: [OID_A],
            paths: ["CHANGELOG.md", "package.json"],
            subject: "chore: release v1.2.3",
          }),
        ],
        OID_D,
      ),
      preReleaseTargetOid: OID_A,
    });
    assert.strictEqual(result.preReleaseTargetOid, OID_D);
  });

  it("rejects final release target drift, extra parents, wrong subject, and paths", () => {
    const baseOptions = {
      markdown: validIncludedMarkdown([OID_A]),
      version: "1.2.3",
      preReleaseTargetOid: OID_A,
    };

    for (const finalCommit of [
      commitEntry(OID_D, {
        parents: [OID_B],
        paths: ["CHANGELOG.md"],
        subject: "chore: release v1.2.3",
      }),
      commitEntry(OID_D, {
        parents: [OID_A, OID_B],
        paths: ["CHANGELOG.md"],
        subject: "chore: release v1.2.3",
      }),
      commitEntry(OID_D, {
        parents: [OID_A],
        paths: ["CHANGELOG.md"],
        subject: "chore: publish v1.2.3",
      }),
      commitEntry(OID_D, {
        parents: [OID_A],
        paths: ["CHANGELOG.md", "src/main.ts"],
        subject: "chore: release v1.2.3",
      }),
    ]) {
      assert.throws(
        () =>
          validateReleaseNoteCoverage({
            ...baseOptions,
            inventory: inventory([commitEntry(OID_A), finalCommit], OID_D),
          }),
        /final release commit/i,
      );
    }
  });
});

describe("readReleaseInventory", () => {
  it("resolves annotated tags through commit objects", (t) => {
    const cwd = makeRepo(t);
    const baseOid = commitFile(cwd, "base.txt", "base\n", "base");
    git(cwd, ["tag", "-a", "v1.0.0", "-m", "base tag"]);
    const targetOid = commitFile(cwd, "work.txt", "work\n", "feat: work");
    git(cwd, ["tag", "-a", "v1.1.0", "-m", "target tag"]);

    const result = readReleaseInventory({
      cwd,
      baseTag: "v1.0.0",
      target: "v1.1.0",
    });

    assert.strictEqual(result.baseOid, baseOid);
    assert.strictEqual(result.targetOid, targetOid);
    assert.deepStrictEqual(result.commits.map((entry) => entry.oid), [targetOid]);
    assert.deepStrictEqual(result.commits[0].paths, ["work.txt"]);
  });

  it("forces deterministic UTF-8 commit subjects", (t) => {
    const cwd = makeRepo(t);
    commitFile(cwd, "base.txt", "base\n", "base");
    git(cwd, ["tag", "base"]);
    git(cwd, ["config", "i18n.logOutputEncoding", "ISO-8859-1"]);
    const targetOid = commitFile(cwd, "work.txt", "work\n", "feat: café");

    const result = readReleaseInventory({ cwd, baseTag: "base", target: "HEAD" });

    assert.strictEqual(result.commits[0].oid, targetOid);
    assert.strictEqual(result.commits[0].subject, "feat: café");
  });

  it("rejects missing refs and non-ancestor ranges", (t) => {
    const cwd = makeRepo(t);
    const baseOid = commitFile(cwd, "base.txt", "base\n", "base");
    git(cwd, ["branch", "base"]);
    const leftOid = commitFile(cwd, "left.txt", "left\n", "left");
    git(cwd, ["switch", "-c", "other", baseOid]);
    const rightOid = commitFile(cwd, "right.txt", "right\n", "right");

    assert.throws(
      () =>
        readReleaseInventory({
          cwd,
          baseTag: "missing-tag",
          target: rightOid,
        }),
      /missing ref.*missing-tag/i,
    );
    assert.throws(
      () =>
        readReleaseInventory({
          cwd,
          baseTag: leftOid,
          target: rightOid,
        }),
      /not an ancestor/i,
    );
  });

  it("rejects shallow repositories", (t) => {
    const cwd = makeRepo(t);
    const baseOid = commitFile(cwd, "base.txt", "base\n", "base");
    const targetOid = commitFile(cwd, "work.txt", "work\n", "work");
    const gitDir = git(cwd, ["rev-parse", "--git-dir"]);
    writeFileSync(join(cwd, gitDir, "shallow"), `${baseOid}\n`);

    assert.throws(
      () =>
        readReleaseInventory({
          cwd,
          baseTag: baseOid,
          target: targetOid,
        }),
      /shallow repository/i,
    );
  });

  it("includes merge commits without hiding merged commits", (t) => {
    const cwd = makeRepo(t);
    const baseOid = commitFile(cwd, "base.txt", "base\n", "base");
    git(cwd, ["tag", "base"]);
    git(cwd, ["switch", "-c", "feature"]);
    const featureOid = commitFile(cwd, "feature.txt", "feature\n", "feature");
    git(cwd, ["switch", "main"]);
    const mainOid = commitFile(cwd, "main.txt", "main\n", "main");
    git(cwd, ["merge", "--no-ff", "feature", "-m", "merge feature"]);
    const mergeOid = git(cwd, ["rev-parse", "HEAD"]);

    const result = readReleaseInventory({ cwd, baseTag: "base", target: "HEAD" });
    assert.deepStrictEqual(
      new Set(result.commits.map((entry) => entry.oid)),
      new Set([featureOid, mainOid, mergeOid]),
    );
    assert.strictEqual(
      result.commits.find((entry) => entry.oid === mergeOid)?.parents.length,
      2,
    );
  });

  it("caps aggregate retained inventory across per-commit path reads", (t) => {
    const cwd = makeRepo(t);
    const baseOid = commitFile(cwd, "base.txt", "base\n", "base");
    git(cwd, ["tag", "base"]);
    const firstBlob = git(cwd, ["hash-object", "-w", "--stdin"], {
      input: "first",
    });
    const secondBlob = git(cwd, ["hash-object", "-w", "--stdin"], {
      input: "second",
    });
    const suffix = "x".repeat(170);
    const names = Array.from(
      { length: 48_000 },
      (_, index) => `file-${String(index).padStart(5, "0")}-${suffix}`,
    );
    const makeTree = (blobOid: string) =>
      git(cwd, ["mktree", "-z"], {
        input: names
          .map((name) => `100644 blob ${blobOid}\t${name}\0`)
          .join(""),
      });
    const firstOid = git(
      cwd,
      ["commit-tree", makeTree(firstBlob), "-p", baseOid],
      { input: "first inventory\n" },
    );
    const secondOid = git(
      cwd,
      ["commit-tree", makeTree(secondBlob), "-p", firstOid],
      { input: "second inventory\n" },
    );
    git(cwd, ["update-ref", "refs/heads/main", secondOid]);

    const pathBytes = [firstOid, secondOid].map((oid) =>
      Buffer.byteLength(
        git(cwd, [
          "diff-tree",
          "--root",
          "-m",
          "--no-commit-id",
          "--name-only",
          "-r",
          "-z",
          oid,
        ]),
      ),
    );
    assert.ok(pathBytes.every((bytes) => bytes < 16 * 1024 * 1024));
    assert.ok(pathBytes.reduce((total, bytes) => total + bytes, 0) > 16 * 1024 * 1024);

    assert.throws(
      () => readReleaseInventory({ cwd, baseTag: "base", target: "HEAD" }),
      /aggregate release inventory exceeds 16 MiB/i,
    );
  });

  it("fails closed when Git output exceeds the 16 MiB buffer", (t) => {
    const cwd = makeRepo(t);
    const baseOid = commitFile(cwd, "base.txt", "base\n", "base");
    git(cwd, ["tag", "base"]);
    const treeOid = git(cwd, ["write-tree"]);
    const hugeSubject = `feat: ${"x".repeat(16 * 1024 * 1024)}\n`;
    const targetOid = git(
      cwd,
      ["commit-tree", treeOid, "-p", baseOid],
      { input: hugeSubject },
    );
    git(cwd, ["update-ref", "refs/heads/main", targetOid]);

    assert.throws(
      () => readReleaseInventory({ cwd, baseTag: "base", target: "HEAD" }),
      /buffer|ENOBUFS|maxBuffer/i,
    );
  });
});

describe("buildReleaseNotes", () => {
  it("requires an immutable annotated release tag target", (t) => {
    const { cwd, workOid, releaseOid } = makeTaggedReleaseRepo(t);
    git(cwd, ["tag", "v1.1.0-light", releaseOid]);

    for (const target of ["HEAD", "main", releaseOid, "v1.1.0-light"]) {
      assert.throws(
        () =>
          buildReleaseNotes({
            cwd,
            version: "1.1.0",
            baseTag: "v1.0.0",
            target,
            preReleaseTargetOid: workOid,
          }),
        /annotated release tag/i,
      );
    }
  });

  it("requires the pre-release target object ID", (t) => {
    const { cwd } = makeTaggedReleaseRepo(t);
    assert.throws(
      () =>
        buildReleaseNotes({
          cwd,
          version: "1.1.0",
          baseTag: "v1.0.0",
          target: "v1.1.0",
        }),
      /preReleaseTargetOid is required/i,
    );
  });

  it("reads the tagged changelog and renders one visible commit appendix", (t) => {
    const { cwd, workOid, releaseOid, changelog } = makeTaggedReleaseRepo(t);
    writeFileSync(join(cwd, "CHANGELOG.md"), "working tree must be ignored\n");

    const body = buildReleaseNotes({
      cwd,
      version: "1.1.0",
      baseTag: "v1.0.0",
      target: "v1.1.0",
      preReleaseTargetOid: workOid,
    });

    assert.match(body, /## \[1\.1\.0\]/);
    assert.match(body, /\*\*Work\*\*: Added the work\./);
    assert.doesNotMatch(body, /release-note-commits/);
    assert.strictEqual(body.split("## Commits since v1.0.0").length - 1, 1);
    assert.match(body, new RegExp(workOid));
    assert.match(body, new RegExp(releaseOid));
    assert.ok(!body.includes("working tree must be ignored"));
    assert.ok(changelog.includes(workOid));
  });

  it("rejects validate targets that do not resolve to current HEAD", (t) => {
    const { cwd, workOid } = makeTaggedReleaseRepo(t);
    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          [
            SCRIPT_PATH,
            "validate",
            "--version",
            "1.1.0",
            "--base-tag",
            "v1.0.0",
            "--target",
            workOid,
          ],
          { cwd, encoding: "utf8" },
        ),
      /current HEAD/i,
    );
  });

  it("rejects build-only flags in validate mode", (t) => {
    const { cwd, workOid } = makePreReleaseRepo(t);
    for (const [flag, value] of [
      ["--pre-release-target", workOid],
      ["--output", join(cwd, "notes.md")],
    ]) {
      assert.throws(
        () =>
          execFileSync(
            process.execPath,
            [
              SCRIPT_PATH,
              "validate",
              "--version",
              "1.1.0",
              "--base-tag",
              "v1.0.0",
              "--target",
              "HEAD",
              flag,
              value,
            ],
            { cwd, encoding: "utf8" },
          ),
        /not valid in validate mode/i,
      );
    }
  });

  it("supports validate JSON output and build output-file CLI modes", (t) => {
    const { cwd: validateCwd, workOid } = makePreReleaseRepo(t);
    const validateOutput = execFileSync(
      process.execPath,
      [
        SCRIPT_PATH,
        "validate",
        "--version",
        "1.1.0",
        "--base-tag",
        "v1.0.0",
        "--target",
        workOid,
      ],
      { cwd: validateCwd, encoding: "utf8" },
    );
    assert.deepStrictEqual(JSON.parse(validateOutput), {
      preReleaseTargetOid: workOid,
    });

    const { cwd, workOid: releaseWorkOid } = makeTaggedReleaseRepo(t);
    const output = join(cwd, "release-notes.md");
    execFileSync(
      process.execPath,
      [
        SCRIPT_PATH,
        "build",
        "--version",
        "1.1.0",
        "--base-tag",
        "v1.0.0",
        "--target",
        "v1.1.0",
        "--pre-release-target",
        releaseWorkOid,
        "--output",
        output,
      ],
      { cwd, encoding: "utf8" },
    );
    assert.match(readFileSync(output, "utf8"), /## Commits since v1\.0\.0/);
  });
});


describe("prepare-release coverage integration", () => {
  it("requires an explicit base tag before running release checks", () => {
    let stderr = "";
    try {
      execFileSync(process.execPath, [PREPARE_RELEASE_SCRIPT_PATH], {
        cwd: resolve("."),
        encoding: "utf8",
      });
      assert.fail("prepare-release should reject a missing --base-tag");
    } catch (error) {
      stderr = String((error as { stderr?: string }).stderr ?? error);
    }

    assert.match(stderr, /--base-tag <tag> is required/i);
  });

  it("validates working-tree release-note coverage before expensive checks", () => {
    const source = readFileSync(PREPARE_RELEASE_SCRIPT_PATH, "utf8");
    const coverageIndex = source.indexOf("validateReleaseNoteCoverage({");

    assert.ok(coverageIndex >= 0, "prepare-release should validate release-note coverage");
    for (const command of [
      '["view", `sdl-mcp@${pkg.version}`, "version", "--json"]',
      '["outdated", "--json"]',
      '["run", "build:all"]',
      '["run", "lint"]',
      '["run", "typecheck"]',
      '["test"]',
      '["audit", "--audit-level=high"]',
      '["pack", "--json"]',
      "await runJsonRpcSmokeTest()",
    ]) {
      assert.ok(
        coverageIndex < source.indexOf(command),
        `release-note coverage should run before ${command}`,
      );
    }
  });

  it("prints the validated pre-release target OID as stable JSON", () => {
    const source = readFileSync(PREPARE_RELEASE_SCRIPT_PATH, "utf8");

    assert.match(
      source,
      /console\.log\(JSON\.stringify\(\{ preReleaseTargetOid \}\)\);/,
    );
  });
});


describe("release-notes skill integration", () => {
  for (const skillPath of [
    ".codex/skills/release-notes/SKILL.md",
    ".agents/skills/release-notes/SKILL.md",
  ]) {
    it(`${skillPath} preserves the validated release target through publication`, () => {
      const source = readFileSync(resolve(skillPath), "utf8");

      assert.match(source, /complete, unbounded.*<baseTag>\.\.<target>/i);
      assert.doesNotMatch(source, /git log .*--no-merges/);
      assert.match(source, /concise, grouped summaries/i);
      assert.match(
        source,
        /<!-- release-note-commits: <full-oid>(?: <full-oid>)* -->/,
      );
      assert.match(source, /exactly one visible commit appendix/i);
      assert.match(source, /do not repeat.*commit bullets/i);
      assert.match(source, /save.*preReleaseTargetOid/i);
      assert.match(source, /git tag -a <tag>/);
      assert.ok(
        source.includes(
          "node scripts/build-release-notes.mjs build --version <version> --base-tag <baseTag> --target <tag> --pre-release-target <preReleaseTargetOid> --output <output>",
        ),
        "build command should be one cross-platform runnable line",
      );
      assert.match(source, /gh release create <tag>.*--notes-file <output>/);
      assert.match(source, /stop.*coverage.*target drift.*failure/i);
    });
  }
});


describe("release documentation integration", () => {
  it("passes the required previous tag to prepare-release", () => {
    const source = readFileSync(RELEASE_TEST_DOC_PATH, "utf8");

    assert.match(
      source,
      /npm run prepare-release -- --base-tag <previous-tag>/,
    );
  });
});


describe("release documentation hard-fail list", () => {
  const source = readFileSync(RELEASE_TEST_DOC_PATH, "utf8");

  it("documents missing or invalid explicit base tags", () => {
    assert.match(source, /^- missing or invalid explicit base tag$/m);
  });

  it("documents incomplete coverage or target drift", () => {
    assert.match(source, /^- incomplete release-note coverage or target drift$/m);
  });
});
