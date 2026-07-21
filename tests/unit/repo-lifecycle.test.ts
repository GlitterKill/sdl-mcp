import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

  it("cancels verification before full-index shadow activation closes the active DB", () => {
    const source = readFileSync(
      new URL("../../src/indexer/indexer.ts", import.meta.url),
      "utf8",
    );
    const activation = source.indexOf("activateProviderFirstShadowDbWithHandoff({");
    const cancel = source.indexOf(
      "await cancelAndWaitForGraphIntegrityVerifier(repoId)",
      activation,
    );
    const close = source.indexOf(
      "closeLadybugDb({ preserveCloseHooks: true })",
      activation,
    );

    assert.ok(activation >= 0 && cancel > activation);
    assert.ok(cancel < close, "verification must release its read lease before DB close");
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

  it("restores the prior epoch on abort and advances only committed transitions", async () => {
    const firstEpoch = captureActiveRepoEpoch("repo");
    assert.equal(typeof firstEpoch, "number");

    const removalPromise = beginRepoRemoval("repo");
    assert.equal(captureActiveRepoEpoch("repo"), undefined);
    assert.equal(isRepoEpochCurrent("repo", firstEpoch!), false);
    const removal = await removalPromise;
    removal.abort();
    const afterAbort = captureActiveRepoEpoch("repo");
    assert.equal(afterAbort, firstEpoch);
    assert.equal(isRepoEpochCurrent("repo", firstEpoch!), true);

    const registrationPromise = beginRepoRegistration("repo");
    assert.equal(captureActiveRepoEpoch("repo"), undefined);
    assert.equal(isRepoEpochCurrent("repo", firstEpoch!), false);
    const abortedRegistration = await registrationPromise;
    abortedRegistration.abort();
    assert.equal(captureActiveRepoEpoch("repo"), firstEpoch);
    assert.equal(isRepoEpochCurrent("repo", firstEpoch!), true);

    const secondRemoval = await beginRepoRemoval("repo");
    secondRemoval.commitTombstone();
    assert.equal(captureActiveRepoEpoch("repo"), undefined);

    const registration = await beginRepoRegistration("repo");
    registration.commitActive();
    const reactivated = captureActiveRepoEpoch("repo")!;
    assert.ok(reactivated > firstEpoch!);
    assert.equal(captureActiveRepoEpoch("repo"), reactivated);
    assert.equal(
      await withRepoMutation("repo", async ({ epoch }) => epoch),
      reactivated,
    );
  });
});
