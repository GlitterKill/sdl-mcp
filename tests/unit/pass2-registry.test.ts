import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createDefaultPass2ResolverRegistry,
  createPass2ResolverRegistry,
  toPass2Target,
} from "../../dist/indexer/pass2/registry.js";
import type {
  Pass2Resolver,
  Pass2ResolverContext,
  Pass2Target,
  Pass2ResolverResult,
} from "../../dist/indexer/pass2/types.js";

class FakeResolver implements Pass2Resolver {
  id: string;
  private supportsTarget: (target: Pass2Target) => boolean;

  constructor(
    id: string,
    supportsTarget: (target: Pass2Target) => boolean,
  ) {
    this.id = id;
    this.supportsTarget = supportsTarget;
  }

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
      new FakeResolver(
        "typescript",
        (target) => target.language === "typescript",
      ),
    ]);

    const resolver = registry.getResolver(
      toPass2Target({ path: "src/index.ts" }),
    );

    assert.equal(resolver?.id, "typescript");
    assert.equal(
      registry.supports(toPass2Target({ path: "src/index.ts" })),
      true,
    );
  });

  it("returns undefined for unsupported file types", () => {
    const registry = createPass2ResolverRegistry([
      new FakeResolver(
        "typescript",
        (target) => target.language === "typescript",
      ),
    ]);

    const resolver = registry.getResolver(
      toPass2Target({ path: "src/script.py" }),
    );

    assert.equal(resolver, undefined);
    assert.equal(
      registry.supports(toPass2Target({ path: "src/script.py" })),
      false,
    );
  });

  it("uses the default registry for ts, go, php, python, java, kotlin, rust, csharp, cpp, c, and shell pass2 targets", () => {
    const registry = createDefaultPass2ResolverRegistry();

    assert.equal(
      registry.supports(toPass2Target({ path: "src/index.ts" })),
      true,
    );
    assert.equal(
      registry.supports(toPass2Target({ path: "src/view.tsx" })),
      true,
    );
    assert.equal(
      registry.supports(toPass2Target({ path: "src/index.js" })),
      true,
    );
    assert.equal(
      registry.supports(toPass2Target({ path: "src/view.jsx" })),
      true,
    );
    assert.equal(
      registry.supports(toPass2Target({ path: "src/main.go" })),
      true,
    );
    assert.equal(
      registry.supports(toPass2Target({ path: "src/index.php" })),
      true,
    );
    assert.equal(
      registry.supports(toPass2Target({ path: "templates/view.phtml" })),
      true,
    );
    assert.equal(
      registry.supports(toPass2Target({ path: "src/script.py" })),
      true,
    );
    assert.equal(
      registry.supports(toPass2Target({ path: "src/Main.java" })),
      true,
    );
    assert.equal(
      registry.supports(toPass2Target({ path: "src/Main.kt" })),
      true,
    );
    assert.equal(
      registry.supports(toPass2Target({ path: "scripts/build.kts" })),
      true,
    );
    assert.equal(
      registry.supports(toPass2Target({ path: "src/lib.rs" })),
      true,
    );
    assert.equal(
      registry.supports(toPass2Target({ path: "src/Program.cs" })),
      true,
    );
    // C++ extensions
    assert.equal(
      registry.supports(toPass2Target({ path: "src/main.cpp" })),
      true,
    );
    assert.equal(
      registry.supports(toPass2Target({ path: "src/widget.hpp" })),
      true,
    );
    assert.equal(
      registry.supports(toPass2Target({ path: "src/main.cc" })),
      true,
    );
    assert.equal(
      registry.supports(toPass2Target({ path: "src/util.cxx" })),
      true,
    );
    assert.equal(
      registry.supports(toPass2Target({ path: "src/types.hxx" })),
      true,
    );
    // C extensions
    assert.equal(
      registry.supports(toPass2Target({ path: "src/main.c" })),
      true,
    );
    assert.equal(
      registry.supports(toPass2Target({ path: "include/utils.h" })),
      true,
    );
    // Shell extensions
    assert.equal(
      registry.supports(toPass2Target({ path: "scripts/deploy.sh" })),
      true,
    );
    assert.equal(
      registry.supports(toPass2Target({ path: "scripts/build.bash" })),
      true,
    );
  });
});
