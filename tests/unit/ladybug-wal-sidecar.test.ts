import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  quarantineDanglingWalCheckpointSidecar,
} from "../../dist/db/ladybug.js";

describe("LadybugDB WAL checkpoint sidecar recovery", () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  function makePath(): string {
    tempDir = join(tmpdir(), `sdl-mcp-wal-sidecar-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    return join(tempDir, "graph.lbug");
  }

  it("quarantines dangling checkpoint sidecars when no WAL exists", () => {
    const dbPath = makePath();
    const sidecarPath = `${dbPath}.wal.checkpoint`;
    writeFileSync(sidecarPath, "partial checkpoint");

    const result = quarantineDanglingWalCheckpointSidecar(dbPath, 12345);

    assert.equal(result.status, "quarantined");
    assert.equal(existsSync(sidecarPath), false);
    assert.equal(
      existsSync(`${sidecarPath}.quarantined-12345`),
      true,
    );
  });

  it("does not quarantine checkpoint sidecars while a WAL exists", () => {
    const dbPath = makePath();
    const sidecarPath = `${dbPath}.wal.checkpoint`;
    writeFileSync(sidecarPath, "checkpoint");
    writeFileSync(`${dbPath}.wal`, "wal");

    const result = quarantineDanglingWalCheckpointSidecar(dbPath, 12345);

    assert.equal(result.status, "wal-present");
    assert.equal(existsSync(sidecarPath), true);
  });

  it("does not overwrite an existing quarantine file", () => {
    const dbPath = makePath();
    const sidecarPath = `${dbPath}.wal.checkpoint`;
    writeFileSync(sidecarPath, "new checkpoint");
    writeFileSync(`${sidecarPath}.quarantined-12345`, "old checkpoint");

    const result = quarantineDanglingWalCheckpointSidecar(dbPath, 12345);

    assert.equal(result.status, "quarantined");
    assert.equal(
      existsSync(`${sidecarPath}.quarantined-12345-1`),
      true,
    );
  });
});
