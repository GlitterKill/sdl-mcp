import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createDefaultPass2ResolverRegistry,
  createPass2ResolverRegistry,
  toPass2Target,
} from "../../src/indexer/pass2/registry.js";
import type {
  Pass2Resolver,
  Pass2ResolverContext,
  Pass2Target,
  Pass2ResolverResult,
} from "../../src/indexer/pass2/types.js";

class FakeResolver implements Pass2Resolver {
  constructor(
    readonly id: string,
    private readonly supportsTarget: (target: Pass2Target) => boolean,
  ) {}

  supports(target: Pass2Target): boolean {
    return this.supportsTarget(target);
  }

  async resolve(
    _target: Pass2Target,
    _context: Pass2ResolverContext,
  ): Promise<Pass2ResolverResult> {
    return { edgesCreated: 0 };
  }
}

describe("pass2 resolver registry", () => {
  it("returns the first resolver that supports the target", () => {
    const registry = createPass2ResolverRegistry([
      new FakeResolver("go", (target) => target.language === "go"),
      new FakeResolver("typescript", (target) => target.language === "typescript"),
    ]);

    const resolver = registry.getResolver(
      toPass2Target({
        path: "src/index.ts",
        size: 10,
        mtime: 0,
      }),
    );

    assert.equal(resolver?.id, "typescript");
    assert.equal(registry.supports(toPass2Target({ path: "src/index.ts", size: 1, mtime: 0 })), true);
  });

  it("returns undefined for unsupported file types", () => {
    const registry = createPass2ResolverRegistry([
      new FakeResolver("typescript", (target) => target.language === "typescript"),
    ]);

    const resolver = registry.getResolver(
      toPass2Target({
        path: "src/script.py",
        size: 10,
        mtime: 0,
      }),
    );

    assert.equal(resolver, undefined);
    assert.equal(registry.supports(toPass2Target({ path: "src/script.py", size: 1, mtime: 0 })), false);
  });

  it("uses the default registry for current ts and js pass2 targets", () => {
    const registry = createDefaultPass2ResolverRegistry();

    assert.equal(registry.supports(toPass2Target({ path: "src/index.ts", size: 1, mtime: 0 })), true);
    assert.equal(registry.supports(toPass2Target({ path: "src/view.tsx", size: 1, mtime: 0 })), true);
    assert.equal(registry.supports(toPass2Target({ path: "src/index.js", size: 1, mtime: 0 })), true);
    assert.equal(registry.supports(toPass2Target({ path: "src/view.jsx", size: 1, mtime: 0 })), true);
    assert.equal(registry.supports(toPass2Target({ path: "src/main.go", size: 1, mtime: 0 })), true);
    assert.equal(registry.supports(toPass2Target({ path: "src/script.py", size: 1, mtime: 0 })), false);
  });
});
