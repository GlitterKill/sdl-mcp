import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

export function assertInstalledFtsArtifact(home, contract) {
  const path = join(home, contract.installedPath);
  const actualPath = realpathSync.native(path);
  const relativePath = relative(realpathSync.native(home), actualPath);
  assert.ok(
    relativePath &&
      !isAbsolute(relativePath) &&
      relativePath !== ".." &&
      !relativePath.startsWith(".." + sep),
    "FTS artifact is outside the isolated home",
  );
  const bytes = readFileSync(actualPath);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  assert.equal(
    bytes.length,
    contract.artifactSize,
    "installed FTS artifact size mismatch",
  );
  assert.equal(
    sha256,
    contract.artifactSha256,
    "installed FTS artifact SHA-256 mismatch",
  );
  return { path, sha256, size: bytes.length };
}
