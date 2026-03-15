import { describe, it } from "node:test";
import assert from "node:assert";

import {
  ArtifactCleanupError,
  ArtifactNotFoundError,
  ConfigError,
  DatabaseError,
  ErrorCode,
  IndexError,
  NotFoundError,
  PolicyError,
  RuntimeNotFoundError,
  RuntimeOutputLimitError,
  RuntimePolicyDeniedError,
  RuntimeTimeoutError,
  ValidationError,
} from "../../src/domain/errors.js";

describe("domain errors", () => {
  const cases = [
    {
      name: "ConfigError",
      code: ErrorCode.CONFIG_ERROR,
      Ctor: ConfigError,
    },
    {
      name: "DatabaseError",
      code: ErrorCode.DATABASE_ERROR,
      Ctor: DatabaseError,
    },
    {
      name: "IndexError",
      code: ErrorCode.INDEX_ERROR,
      Ctor: IndexError,
    },
    {
      name: "ValidationError",
      code: ErrorCode.VALIDATION_ERROR,
      Ctor: ValidationError,
    },
    {
      name: "PolicyError",
      code: ErrorCode.POLICY_ERROR,
      Ctor: PolicyError,
    },
    {
      name: "NotFoundError",
      code: ErrorCode.NOT_FOUND,
      Ctor: NotFoundError,
    },
    {
      name: "RuntimePolicyDeniedError",
      code: ErrorCode.POLICY_ERROR,
      Ctor: RuntimePolicyDeniedError,
    },
    {
      name: "RuntimeNotFoundError",
      code: ErrorCode.RUNTIME_ERROR,
      Ctor: RuntimeNotFoundError,
    },
    {
      name: "RuntimeTimeoutError",
      code: ErrorCode.RUNTIME_ERROR,
      Ctor: RuntimeTimeoutError,
    },
    {
      name: "RuntimeOutputLimitError",
      code: ErrorCode.RUNTIME_ERROR,
      Ctor: RuntimeOutputLimitError,
    },
    {
      name: "ArtifactNotFoundError",
      code: ErrorCode.RUNTIME_ERROR,
      Ctor: ArtifactNotFoundError,
    },
    {
      name: "ArtifactCleanupError",
      code: ErrorCode.RUNTIME_ERROR,
      Ctor: ArtifactCleanupError,
    },
  ] as const;

  for (const testCase of cases) {
    it(`${testCase.name} sets name/code/message and preserves Error prototype chain`, () => {
      const message = `failure in ${testCase.name}`;
      const error = new testCase.Ctor(message);

      assert.ok(error instanceof Error);
      assert.ok(error instanceof testCase.Ctor);
      assert.strictEqual(error.name, testCase.name);
      assert.strictEqual(error.code, testCase.code);
      assert.strictEqual(error.message, message);
      assert.strictEqual(Object.getPrototypeOf(error), testCase.Ctor.prototype);
    });
  }
});
