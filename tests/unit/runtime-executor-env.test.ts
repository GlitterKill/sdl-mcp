import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { buildScrubbedEnv } from "../../dist/runtime/executor.js";

describe("buildScrubbedEnv with requiredEnvKeys", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.GOPATH = "/home/user/go";
    process.env.JAVA_HOME = "/usr/lib/jvm/java-17";
    process.env.SECRET_KEY = "should-not-leak";
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  });

  it("should include requiredEnvKeys when present in process.env", () => {
    const env = buildScrubbedEnv([], ["GOPATH", "JAVA_HOME"]);
    assert.strictEqual(env.GOPATH, "/home/user/go");
    assert.strictEqual(env.JAVA_HOME, "/usr/lib/jvm/java-17");
  });

  it("should not include requiredEnvKeys that are absent from process.env", () => {
    const env = buildScrubbedEnv([], ["KOTLIN_HOME"]);
    assert.strictEqual(env.KOTLIN_HOME, undefined);
  });

  it("should not include non-required, non-allowed keys", () => {
    const env = buildScrubbedEnv([], ["GOPATH"]);
    assert.strictEqual(env.SECRET_KEY, undefined);
  });

  it("should merge requiredEnvKeys with allowedKeys", () => {
    process.env.MY_ALLOWED = "yes";
    const env = buildScrubbedEnv(["MY_ALLOWED"], ["GOPATH"]);
    assert.strictEqual(env.GOPATH, "/home/user/go");
    assert.strictEqual(env.MY_ALLOWED, "yes");
    delete process.env.MY_ALLOWED;
  });
});
