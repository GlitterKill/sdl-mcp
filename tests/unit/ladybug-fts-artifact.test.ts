import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { it } from "node:test";

import { assertInstalledFtsArtifact } from "../../scripts/ladybug-fts-artifact.mjs";

const ftsContract = JSON.parse(
  readFileSync("ladybug-openssl/ladybug-fts-0.19.0.json", "utf8"),
);
const expectedBytes = Buffer.from("expected artifact");

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function createFixture({
  artifactBytes = expectedBytes,
  writeArtifact = true,
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "sdl-fts-artifact-test-"));
  const home = join(root, "isolated-home");
  const contract = {
    ...ftsContract,
    artifactSha256: sha256(expectedBytes),
    artifactSize: expectedBytes.byteLength,
  };
  const artifactPath = join(home, contract.installedPath);
  mkdirSync(dirname(artifactPath), { recursive: true });
  if (writeArtifact) writeFileSync(artifactPath, artifactBytes);
  return {
    root,
    home,
    contract,
    artifactPath,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

it("accepts the expected FTS artifact at its contract path", () => {
  const fixture = createFixture();
  try {
    assert.deepEqual(
      assertInstalledFtsArtifact(fixture.home, fixture.contract),
      {
        path: fixture.artifactPath,
        sha256: sha256(expectedBytes),
        size: expectedBytes.byteLength,
      },
    );
  } finally {
    fixture.cleanup();
  }
});

it("rejects different bytes even when their size matches the contract", () => {
  const differentBytes = Buffer.from("different payload");
  assert.equal(differentBytes.byteLength, expectedBytes.byteLength);
  const fixture = createFixture({ artifactBytes: differentBytes });
  try {
    assert.throws(
      () => assertInstalledFtsArtifact(fixture.home, fixture.contract),
      /SHA-256 mismatch/u,
    );
  } finally {
    fixture.cleanup();
  }
});

it("rejects an installed artifact with the wrong size", () => {
  const fixture = createFixture();
  try {
    assert.throws(
      () =>
        assertInstalledFtsArtifact(fixture.home, {
          ...fixture.contract,
          artifactSize: expectedBytes.byteLength + 1,
        }),
      /size mismatch/u,
    );
  } finally {
    fixture.cleanup();
  }
});

it("rejects a missing FTS artifact at the contract path", () => {
  const fixture = createFixture({ writeArtifact: false });
  try {
    assert.throws(() =>
      assertInstalledFtsArtifact(fixture.home, fixture.contract),
    );
  } finally {
    fixture.cleanup();
  }
});

it("rejects an FTS artifact symlink that escapes the isolated home", (t) => {
  const fixture = createFixture({ writeArtifact: false });
  const outsidePath = join(fixture.root, "outside.lbug_extension");
  writeFileSync(outsidePath, expectedBytes);
  try {
    try {
      symlinkSync(outsidePath, fixture.artifactPath, "file");
    } catch (error) {
      const code =
        error && typeof error === "object" && "code" in error
          ? error.code
          : undefined;
      if (
        process.platform === "win32" &&
        (code === "EPERM" || code === "EACCES")
      ) {
        t.skip(
          "Windows symlink creation is unavailable without developer privileges",
        );
        return;
      }
      throw error;
    }

    assert.throws(
      () => assertInstalledFtsArtifact(fixture.home, fixture.contract),
      /outside the isolated home/u,
    );
  } finally {
    fixture.cleanup();
  }
});
