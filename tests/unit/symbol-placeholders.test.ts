import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  classifyDependencyTarget,
  externalImportDependencyTarget,
} from "../../dist/db/symbol-placeholders.js";

describe("dependency placeholder classification", () => {
  it("classifies bare and runtime module import placeholders as external", () => {
    assert.deepEqual(
      classifyDependencyTarget("unresolved:node:test:describe"),
      externalImportDependencyTarget("describe (from node:test)"),
    );
    assert.deepEqual(
      classifyDependencyTarget("unresolved:fs:readFileSync"),
      externalImportDependencyTarget("readFileSync (from fs)"),
    );
    assert.deepEqual(
      classifyDependencyTarget("unresolved:zod:z"),
      externalImportDependencyTarget("z (from zod)"),
    );
    assert.deepEqual(
      classifyDependencyTarget("unresolved:std::collections::HashSet:HashSet"),
      externalImportDependencyTarget("HashSet (from std::collections::HashSet)"),
    );
    assert.deepEqual(
      classifyDependencyTarget("unresolved:java.util.List:List"),
      externalImportDependencyTarget("List (from java.util.List)"),
    );
  });

  it("keeps repo-local unresolved targets separate from external imports", () => {
    assert.deepEqual(classifyDependencyTarget("unresolved:src/db/foo.ts:Foo"), {
      symbolStatus: "unresolved",
      placeholderKind: "import",
      placeholderTarget: "Foo (from src/db/foo.ts)",
    });
    assert.deepEqual(classifyDependencyTarget("unresolved:call:makeSession"), {
      symbolStatus: "unresolved",
      placeholderKind: "call",
      placeholderTarget: "makeSession",
    });
  });

  it("keeps common path-alias misses unresolved", () => {
    assert.deepEqual(classifyDependencyTarget("unresolved:@/internal/foo:Foo"), {
      symbolStatus: "unresolved",
      placeholderKind: "import",
      placeholderTarget: "Foo (from @/internal/foo)",
    });
    assert.deepEqual(classifyDependencyTarget("unresolved:@app/foo:Foo"), {
      symbolStatus: "unresolved",
      placeholderKind: "import",
      placeholderTarget: "Foo (from @app/foo)",
    });
    assert.deepEqual(classifyDependencyTarget("unresolved:@repo/pkg:Foo"), {
      symbolStatus: "unresolved",
      placeholderKind: "import",
      placeholderTarget: "Foo (from @repo/pkg)",
    });
    assert.deepEqual(classifyDependencyTarget("unresolved:@features/foo:Foo"), {
      symbolStatus: "unresolved",
      placeholderKind: "import",
      placeholderTarget: "Foo (from @features/foo)",
    });
    assert.deepEqual(classifyDependencyTarget("unresolved:~/internal/foo:Foo"), {
      symbolStatus: "unresolved",
      placeholderKind: "import",
      placeholderTarget: "Foo (from ~/internal/foo)",
    });
    assert.deepEqual(classifyDependencyTarget("unresolved:#imports/foo:Foo"), {
      symbolStatus: "unresolved",
      placeholderKind: "import",
      placeholderTarget: "Foo (from #imports/foo)",
    });
  });

  it("classifies package subpath imports as external", () => {
    assert.deepEqual(
      classifyDependencyTarget(
        "unresolved:@modelcontextprotocol/sdk/client/index.js:Client",
      ),
      externalImportDependencyTarget(
        "Client (from @modelcontextprotocol/sdk/client/index.js)",
      ),
    );
    assert.deepEqual(
      classifyDependencyTarget("unresolved:lodash/fp.js:flow"),
      externalImportDependencyTarget("flow (from lodash/fp.js)"),
    );
  });
});
