import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

import type { RepoConfig } from "../../dist/config/types.js";
import { ConfigError } from "../../dist/domain/errors.js";
import { scanRepository } from "../../dist/indexer/fileScanner.js";
import { _createChokidarIgnoredPredicateForTesting } from "../../dist/indexer/watcher.js";

type ParityCase = {
  name: string;
  pattern: string;
  candidatePath: string;
  isDirectory: boolean;
  ignored: boolean;
};

const PARITY_CASES: readonly ParityCase[] = [
  {
    name: "root literal class",
    pattern: "[Bb]in/",
    candidatePath: "Bin",
    isDirectory: true,
    ignored: true,
  },
  {
    name: "root literal class miss",
    pattern: "[Bb]in/",
    candidatePath: "cin",
    isDirectory: true,
    ignored: false,
  },
  {
    name: "nested literal class",
    pattern: "**/[Bb]in/**",
    candidatePath: "packages/bin",
    isDirectory: true,
    ignored: true,
  },
  {
    name: "lowercase range",
    pattern: "[a-c]ache/**",
    candidatePath: "cache",
    isDirectory: true,
    ignored: true,
  },
  {
    name: "combined ranges",
    pattern: "[A-Za-z0-9_]/**",
    candidatePath: "_",
    isDirectory: true,
    ignored: true,
  },
  {
    name: "escaped closing bracket",
    pattern: "**/[a\\]]/**",
    candidatePath: "packages/]",
    isDirectory: true,
    ignored: true,
  },
  {
    name: "escaped hyphen",
    pattern: "**/[a\\-c]/**",
    candidatePath: "packages/-",
    isDirectory: true,
    ignored: true,
  },
  {
    name: "leading literal hyphen",
    pattern: "**/[-ab]/**",
    candidatePath: "packages/-",
    isDirectory: true,
    ignored: true,
  },
  {
    name: "trailing literal hyphen",
    pattern: "**/[ab-]/**",
    candidatePath: "packages/-",
    isDirectory: true,
    ignored: true,
  },
  {
    name: "non-ASCII literal",
    pattern: "**/[éa]/**",
    candidatePath: "packages/é",
    isDirectory: true,
    ignored: true,
  },
  {
    name: "unmatched opening bracket",
    pattern: "[abc/**",
    candidatePath: "[abc",
    isDirectory: true,
    ignored: true,
  },
  {
    name: "stray closing bracket",
    pattern: "]/**",
    candidatePath: "]",
    isDirectory: true,
    ignored: true,
  },
  {
    name: "digit class file",
    pattern: "[0-3].ts",
    candidatePath: "2.ts",
    isDirectory: false,
    ignored: true,
  },
  {
    name: "digit class file miss",
    pattern: "[0-3].ts",
    candidatePath: "4.ts",
    isDirectory: false,
    ignored: false,
  },
  {
    name: "raw Windows pattern",
    pattern: "**\\[Bb]in\\**",
    candidatePath: "packages/Bin",
    isDirectory: true,
    ignored: true,
  },
  {
    name: "dot and repeated separators",
    pattern: "./tmp/../[Bb]in//**",
    candidatePath: "Bin",
    isDirectory: true,
    ignored: true,
  },
  {
    name: "parent segment normalization",
    pattern: "cache/../[Bb]in/**",
    candidatePath: "Bin",
    isDirectory: true,
    ignored: true,
  },
];

const INVALID_PARITY_PATTERNS = [
  "[]/**",
  "[!a]/**",
  "[^a]/**",
  "[z-a]/**",
  "[A-z]/**",
  "[0-a]/**",
  "[é-a]/**",
  "[[a]/**",
  "[a\\q]/**",
  String.raw`**\[a\q]\**`,
  "[a-b-c]/**",
] as const;

const tempDirectories: string[] = [];

function makeTempRepo(): string {
  const repoRoot = mkdtempSync(join(tmpdir(), "sdl-safe-glob-"));
  tempDirectories.push(repoRoot);
  return repoRoot;
}

function repoConfig(repoRoot: string, pattern: string): RepoConfig {
  return {
    repoId: "safe-glob-parity",
    rootPath: repoRoot,
    ignore: [pattern],
    languages: ["ts"],
    maxFileBytes: 1_000_000,
    includeNodeModulesTypes: false,
    packageJsonPath: null,
    tsconfigPath: null,
    workspaceGlobs: null,
  };
}

function statsLike(isDirectory: boolean): { isDirectory(): boolean } {
  return { isDirectory: () => isDirectory };
}

function materializeCandidate(
  repoRoot: string,
  testCase: ParityCase,
): string {
  const relativeFile = testCase.isDirectory
    ? testCase.candidatePath + "/target.ts"
    : testCase.candidatePath;
  const absoluteFile = join(repoRoot, ...relativeFile.split("/"));
  mkdirSync(dirname(absoluteFile), { recursive: true });
  writeFileSync(absoluteFile, "export const target = true;\n", "utf8");
  return relativeFile;
}

after(() => {
  for (const directory of tempDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("safe glob scanner and watcher parity", () => {
  for (const testCase of PARITY_CASES) {
    it(testCase.name, async () => {
      const repoRoot = makeTempRepo();
      const relativeFile = materializeCandidate(repoRoot, testCase);
      writeFileSync(
        join(repoRoot, "keep.ts"),
        "export const keep = true;\n",
        "utf8",
      );

      const scanned = await scanRepository(
        repoRoot,
        repoConfig(repoRoot, testCase.pattern),
      );
      const scannedPaths = scanned.map((file) => file.path);
      assert.equal(scannedPaths.includes("keep.ts"), true);
      assert.equal(
        scannedPaths.includes(relativeFile),
        !testCase.ignored,
        "scanner mismatch for " + testCase.pattern,
      );

      const ignored = _createChokidarIgnoredPredicateForTesting(
        resolve(repoRoot),
        [testCase.pattern],
      );
      const absoluteCandidate = join(
        repoRoot,
        ...testCase.candidatePath.split("/"),
      );
      const windowsRelativeCandidate =
        testCase.candidatePath.replaceAll("/", "\\");

      assert.equal(
        ignored(absoluteCandidate, statsLike(testCase.isDirectory)),
        testCase.ignored,
        "absolute watcher mismatch for " + testCase.pattern,
      );
      assert.equal(
        ignored(
          windowsRelativeCandidate,
          statsLike(testCase.isDirectory),
        ),
        testCase.ignored,
        "Windows-relative watcher mismatch for " + testCase.pattern,
      );
    });
  }
});

describe("invalid safe glob parity", () => {
  for (const pattern of INVALID_PARITY_PATTERNS) {
    it("rejects " + pattern + " in scanner and watcher compilation", async () => {
      const repoRoot = makeTempRepo();
      writeFileSync(
        join(repoRoot, "keep.ts"),
        "export const keep = true;\n",
        "utf8",
      );

      assert.throws(
        () =>
          _createChokidarIgnoredPredicateForTesting(repoRoot, [pattern]),
        ConfigError,
      );
      await assert.rejects(
        () => scanRepository(repoRoot, repoConfig(repoRoot, pattern)),
        ConfigError,
      );
    });
  }
});
