import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const MAX_GIT_BUFFER = 16 * 1024 * 1024;
const MAX_INVENTORY_BYTES = MAX_GIT_BUFFER;
const FULL_OID = /^[0-9a-f]{40}$/;
const INCLUDE_MARKER =
  /^  <!-- release-note-commits: ([0-9a-f]{40}(?: [0-9a-f]{40})*) -->$/;
const OMIT_MARKER =
  /^<!-- release-note-omit: ([0-9a-f]{40}) ([a-z0-9-]+) -->$/;
const FINAL_RELEASE_PATHS = new Set([
  "CHANGELOG.md",
  "package.json",
  "package-lock.json",
  "packages/create-sdl-mcp/package.json",
  "native/package.json",
  "native/npm/darwin-arm64/package.json",
  "native/npm/darwin-x64/package.json",
  "native/npm/linux-arm64-gnu/package.json",
  "native/npm/linux-x64-gnu/package.json",
  "native/npm/linux-x64-musl/package.json",
  "native/npm/win32-x64-msvc/package.json",
  "watchman/package.json",
  "watchman/npm/linux-x64/package.json",
  "watchman/npm/win32-x64/package.json",
]);

function gitError(error) {
  if (
    error?.code === "ENOBUFS" ||
    String(error?.message).includes("ENOBUFS") ||
    String(error?.message).includes("maxBuffer")
  ) {
    return new Error("Git output exceeded the 16 MiB buffer", { cause: error });
  }
  const stderr =
    typeof error?.stderr === "string"
      ? error.stderr.trim()
      : error?.stderr?.toString("utf8").trim();
  return new Error(stderr || error?.message || "Git command failed", {
    cause: error,
  });
}

// All Git reads cross one bounded, shell-free boundary so partial output is never accepted.
function runGit(cwd, args, options = {}) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: MAX_GIT_BUFFER,
      ...options,
    });
  } catch (error) {
    throw gitError(error);
  }
}

function resolveCommit(cwd, ref) {
  try {
    const oid = runGit(cwd, [
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${ref}^{commit}`,
    ]).trim();
    if (!FULL_OID.test(oid)) {
      throw new Error("Git returned a non-commit object ID");
    }
    return oid;
  } catch (error) {
    throw new Error(`Missing ref: ${ref}`, { cause: error });
  }
}

function requireAnnotatedReleaseTag(cwd, target) {
  let fullRef;
  try {
    fullRef = runGit(cwd, [
      "rev-parse",
      "--symbolic-full-name",
      "--verify",
      "--end-of-options",
      target,
    ]).trim();
  } catch (error) {
    throw new Error("Build target must be an annotated release tag", {
      cause: error,
    });
  }
  if (
    !fullRef.startsWith("refs/tags/") ||
    runGit(cwd, ["cat-file", "-t", fullRef]).trim() !== "tag"
  ) {
    throw new Error("Build target must be an annotated release tag");
  }
}

function isAncestor(cwd, baseOid, targetOid) {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", baseOid, targetOid], {
      cwd,
      encoding: "utf8",
      maxBuffer: MAX_GIT_BUFFER,
    });
    return true;
  } catch (error) {
    if (error?.status === 1) {
      return false;
    }
    throw gitError(error);
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^$()|[\]\\]/g, "\\$&");
}

function findVersionSection(markdown, version) {
  const normalized = markdown.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  const heading = new RegExp(
    `^## \\[${escapeRegExp(version)}\\](?: - \\d{4}-\\d{2}-\\d{2})?$`,
  );
  const starts = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (heading.test(lines[index])) {
      starts.push(index);
    }
  }
  if (starts.length !== 1) {
    throw new Error(
      `Expected exactly one changelog section for version ${version}; found ${starts.length}`,
    );
  }

  const start = starts[0];
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index].startsWith("## ")) {
      end = index;
      break;
    }
  }
  while (end > start + 1 && lines[end - 1] === "") {
    end -= 1;
  }
  return { end, lines, start };
}

export function extractVersionSection(markdown, version) {
  const { end, lines, start } = findVersionSection(markdown, version);
  return lines.slice(start, end).join("\n");
}

function assignCommit(assignments, oid, kind) {
  const existing = assignments.get(oid);
  if (existing === kind) {
    throw new Error(`Duplicate release-note assignment: ${oid}`);
  }
  if (existing !== undefined) {
    throw new Error(`Commit is both included and omitted: ${oid}`);
  }
  assignments.set(oid, kind);
}

function validateFinalReleaseCommit(commit, version, preReleaseTargetOid) {
  if (
    commit.parents.length !== 1 ||
    commit.parents[0] !== preReleaseTargetOid ||
    commit.subject !== `chore: release v${version}` ||
    commit.paths.some((path) => !FINAL_RELEASE_PATHS.has(path))
  ) {
    throw new Error(
      "Invalid final release commit: parent, subject, or changed paths do not match the release contract",
    );
  }
}

export function validateReleaseNoteCoverage({
  markdown,
  version,
  inventory,
  preReleaseTargetOid,
}) {
  const { end, lines, start } = findVersionSection(markdown, version);
  const section = lines.slice(start, end).join("\n");
  const commitsByOid = new Map(
    inventory.commits.map((commit) => [commit.oid, commit]),
  );
  const assignments = new Map();

  // Marker parsing is intentionally line-bound: permissive Markdown parsing would
  // make adjacency and malformed-marker rejection ambiguous.
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const hasIncludeToken = line.includes("release-note-commits");
    const hasOmitToken = line.includes("release-note-omit");
    if (!hasIncludeToken && !hasOmitToken) {
      continue;
    }
    if (index < start || index >= end) {
      throw new Error(
        `Release-note marker outside version ${version} section on line ${index + 1}`,
      );
    }

    if (hasIncludeToken) {
      const match = INCLUDE_MARKER.exec(line);
      if (match === null) {
        throw new Error(
          `Malformed release-note-commits marker on line ${index + 1}`,
        );
      }
      if (!lines[index - 1]?.startsWith("- ")) {
        throw new Error(
          `Orphaned release-note-commits marker on line ${index + 1}`,
        );
      }
      for (const oid of match[1].split(" ")) {
        assignCommit(assignments, oid, "include");
      }
      continue;
    }

    const match = OMIT_MARKER.exec(line);
    if (match === null) {
      throw new Error(
        `Malformed release-note-omit marker on line ${index + 1}`,
      );
    }
    const [, oid, reason] = match;
    if (reason !== "merge-only") {
      throw new Error(`Invalid omission code: ${reason}`);
    }
    assignCommit(assignments, oid, "omit");
  }

  for (const [oid, kind] of assignments) {
    const commit = commitsByOid.get(oid);
    if (commit === undefined) {
      throw new Error(`Unknown release-note commit: ${oid}`);
    }
    if (kind === "omit" && commit.parents.length <= 1) {
      throw new Error(`merge-only requires multiple parents: ${oid}`);
    }
  }

  let implicitReleaseOid;
  if (preReleaseTargetOid !== undefined) {
    const targetCommit = commitsByOid.get(inventory.targetOid);
    if (targetCommit === undefined) {
      throw new Error("Invalid final release commit: target is not in inventory");
    }
    validateFinalReleaseCommit(targetCommit, version, preReleaseTargetOid);
    implicitReleaseOid = targetCommit.oid;
  }

  const missing = inventory.commits
    .filter(
      (commit) =>
        !assignments.has(commit.oid) && commit.oid !== implicitReleaseOid,
    )
    .map((commit) => commit.oid);
  if (missing.length > 0) {
    throw new Error(`Missing release-note commit IDs: ${missing.join(" ")}`);
  }

  return { preReleaseTargetOid: inventory.targetOid, section };
}

export function readReleaseInventory({ cwd, baseTag, target }) {
  if (runGit(cwd, ["rev-parse", "--is-shallow-repository"]).trim() === "true") {
    throw new Error("Release inventory requires a non-shallow repository");
  }

  const baseOid = resolveCommit(cwd, baseTag);
  const targetOid = resolveCommit(cwd, target);
  if (!isAncestor(cwd, baseOid, targetOid)) {
    throw new Error(`Base ref ${baseTag} is not an ancestor of ${target}`);
  }

  const output = runGit(cwd, [
    "log",
    "--reverse",
    "--topo-order",
    "--encoding=UTF-8",
    "--format=%H%x1f%P%x1f%s%x1e",
    `${baseOid}..${targetOid}`,
  ]);
  const commits = [];
  let retainedBytes = 0;

  for (const rawRecord of output.split("\x1e")) {
    const record = rawRecord.replace(/^\r?\n/, "").replace(/\r?\n$/, "");
    if (record === "") {
      continue;
    }
    const fields = record.split("\x1f");
    if (fields.length !== 3 || !FULL_OID.test(fields[0])) {
      throw new Error("Malformed Git release inventory output");
    }
    const [oid, parentsText, subject] = fields;
    const recordBytes = Buffer.byteLength(record);
    if (retainedBytes + recordBytes > MAX_INVENTORY_BYTES) {
      throw new Error("Aggregate release inventory exceeds 16 MiB");
    }
    const pathOutput = runGit(cwd, [
      "diff-tree",
      "--root",
      "-m",
      "--no-commit-id",
      "--name-only",
      "-r",
      "-z",
      oid,
    ]);
    const pathBytes = Buffer.byteLength(pathOutput);
    if (retainedBytes + recordBytes + pathBytes > MAX_INVENTORY_BYTES) {
      throw new Error("Aggregate release inventory exceeds 16 MiB");
    }
    retainedBytes += recordBytes + pathBytes;
    const paths = [...new Set(pathOutput.split("\0").filter(Boolean))].sort();
    commits.push({
      oid,
      parents: parentsText === "" ? [] : parentsText.split(" "),
      paths,
      subject,
    });
  }

  return { baseOid, targetOid, commits };
}

function renderSection(section) {
  return section
    .split("\n")
    .filter(
      (line) =>
        !line.includes("release-note-commits") &&
        !line.includes("release-note-omit"),
    )
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
}

export function buildReleaseNotes({
  cwd,
  version,
  baseTag,
  target,
  preReleaseTargetOid,
}) {
  if (!FULL_OID.test(preReleaseTargetOid ?? "")) {
    throw new Error("preReleaseTargetOid is required and must be a full object ID");
  }
  requireAnnotatedReleaseTag(cwd, target);
  const inventory = readReleaseInventory({ cwd, baseTag, target });
  const markdown = runGit(cwd, [
    "show",
    `${inventory.targetOid}:CHANGELOG.md`,
  ]);
  const { section } = validateReleaseNoteCoverage({
    inventory,
    markdown,
    preReleaseTargetOid,
    version,
  });
  const commits = inventory.commits
    .map((commit) => `- \`${commit.oid}\` ${commit.subject}`)
    .join("\n");

  return [
    renderSection(section),
    `## Commits since ${baseTag}`,
    commits,
  ].join("\n\n") + "\n";
}

function parseCliArguments(argv) {
  const mode = argv[0];
  if (mode !== "validate" && mode !== "build") {
    throw new Error("Usage: build-release-notes.mjs <validate|build> [options]");
  }
  const values = {};
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new Error(`Missing value for CLI option: ${flag ?? "(missing)"}`);
    }
    if (values[flag] !== undefined) {
      throw new Error(`Duplicate CLI option: ${flag}`);
    }
    values[flag] = value;
  }
  for (const flag of Object.keys(values)) {
    if (
      ![
        "--version",
        "--base-tag",
        "--target",
        "--pre-release-target",
        "--output",
      ].includes(flag)
    ) {
      throw new Error(`Unknown CLI option: ${flag}`);
    }
  }
  for (const flag of ["--version", "--base-tag", "--target"]) {
    if (values[flag] === undefined) {
      throw new Error(`Missing required CLI option: ${flag}`);
    }
  }
  if (
    mode === "validate" &&
    (values["--pre-release-target"] !== undefined ||
      values["--output"] !== undefined)
  ) {
    throw new Error(
      "--pre-release-target and --output are not valid in validate mode",
    );
  }
  return { mode, values };
}

function runCli(argv) {
  const { mode, values } = parseCliArguments(argv);
  const cwd = process.cwd();
  const version = values["--version"];
  const baseTag = values["--base-tag"];
  const target = values["--target"];

  if (mode === "validate") {
    const inventory = readReleaseInventory({ cwd, baseTag, target });
    if (inventory.targetOid !== resolveCommit(cwd, "HEAD")) {
      throw new Error("Validate target must resolve to current HEAD");
    }
    const markdown = readFileSync(resolve(cwd, "CHANGELOG.md"), "utf8");
    const result = validateReleaseNoteCoverage({
      inventory,
      markdown,
      version,
    });
    process.stdout.write(
      `${JSON.stringify({
        preReleaseTargetOid: result.preReleaseTargetOid,
      })}\n`,
    );
    return;
  }

  const preReleaseTargetOid = values["--pre-release-target"];
  const output = values["--output"];
  if (preReleaseTargetOid === undefined || output === undefined) {
    throw new Error(
      "Build mode requires --pre-release-target and --output",
    );
  }
  const body = buildReleaseNotes({
    cwd,
    version,
    baseTag,
    target,
    preReleaseTargetOid,
  });
  writeFileSync(resolve(cwd, output), body);
}

const entryPath = process.argv[1];
if (
  entryPath !== undefined &&
  pathToFileURL(resolve(entryPath)).href === import.meta.url
) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 1;
  }
}
