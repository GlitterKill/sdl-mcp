import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import {
  beginRepoRemoval,
  beginRepoRegistration,
  captureActiveRepoEpoch,
  isRepoEpochCurrent,
  resetRepoLifecycleForTests,
  withRepoMutation,
} from "../../dist/services/repo-lifecycle.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("per-repository lifecycle barrier", () => {
  beforeEach(() => {
    resetRepoLifecycleForTests();
  });

  it("drains accepted mutations and rejects work arriving after removal starts", async () => {
    const entered = deferred();
    const release = deferred();
    const mutation = withRepoMutation("repo", async ({ epoch }) => {
      entered.resolve();
      await release.promise;
      return epoch;
    });
    await entered.promise;

    const originalEpoch = captureActiveRepoEpoch("repo");
    assert.equal(typeof originalEpoch, "number");
    const removalPromise = beginRepoRemoval("repo");

    await assert.rejects(
      () => withRepoMutation("repo", async () => undefined),
      (error: unknown) => (error as { code?: string }).code === "NOT_FOUND",
    );
    assert.equal(isRepoEpochCurrent("repo", originalEpoch!), false);

    release.resolve();
    assert.equal(await mutation, originalEpoch);
    const removal = await removalPromise;
    removal.commitTombstone();

    await assert.rejects(
      () => withRepoMutation("repo", async () => undefined),
      (error: unknown) => (error as { code?: string }).code === "NOT_FOUND",
    );
  });

  it("advances the epoch on abort and reactivation", async () => {
    const firstEpoch = captureActiveRepoEpoch("repo");
    assert.equal(typeof firstEpoch, "number");

    const removal = await beginRepoRemoval("repo");
    removal.abort();
    const afterAbort = captureActiveRepoEpoch("repo");
    assert.ok(afterAbort! > firstEpoch!);
    assert.equal(isRepoEpochCurrent("repo", firstEpoch!), false);

    const secondRemoval = await beginRepoRemoval("repo");
    secondRemoval.commitTombstone();
    assert.equal(captureActiveRepoEpoch("repo"), undefined);

    const registration = await beginRepoRegistration("repo");
    registration.commitActive();
    const reactivated = captureActiveRepoEpoch("repo")!;
    assert.ok(reactivated > afterAbort!);
    assert.equal(captureActiveRepoEpoch("repo"), reactivated);
    assert.equal(
      await withRepoMutation("repo", async ({ epoch }) => epoch),
      reactivated,
    );
  });
});
