import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import {
  followBarrelChain,
  hooksFromMap,
  hooksFromObjectForTesting,
  MAX_BARREL_DEPTH,
  type ReExport,
} from "../../src/indexer/pass2/barrel-walker.ts";

describe("Phase 2: barrel walker (Task 2.0.2)", () => {
  it("returns null when the start file has no matching re-export", () => {
    const hooks = hooksFromObjectForTesting({
      "pkg/__init__.py": [],
    });
    const result = followBarrelChain("Foo", "pkg/__init__.py", hooks);
    assert.equal(result, null);
  });

  it("follows a single re-export hop", () => {
    const hooks = hooksFromObjectForTesting({
      "pkg/__init__.py": [
        { exportedName: "Foo", targetFile: "pkg/foo.py", targetName: "Foo" },
      ],
      "pkg/foo.py": [],
    });
    const result = followBarrelChain("Foo", "pkg/__init__.py", hooks);
    assert.ok(result);
    assert.equal(result.resolvedFile, "pkg/foo.py");
    assert.equal(result.resolvedName, "Foo");
    assert.equal(result.depth, 1);
  });

  it("follows a 3-deep barrel chain", () => {
    const hooks = hooksFromObjectForTesting({
      "a.py": [{ exportedName: "X", targetFile: "b.py", targetName: "X" }],
      "b.py": [{ exportedName: "X", targetFile: "c.py", targetName: "X" }],
      "c.py": [{ exportedName: "X", targetFile: "d.py", targetName: "X" }],
      "d.py": [],
    });
    const result = followBarrelChain("X", "a.py", hooks);
    assert.ok(result);
    assert.equal(result.resolvedFile, "d.py");
    assert.equal(result.depth, 3);
    assert.deepEqual([...result.visited], ["a.py", "b.py", "c.py", "d.py"]);
  });

  it("renames through a re-export-with-alias chain", () => {
    const hooks = hooksFromObjectForTesting({
      "facade.rs": [
        {
          exportedName: "PublicName",
          targetFile: "internal.rs",
          targetName: "InternalName",
        },
      ],
      "internal.rs": [],
    });
    const result = followBarrelChain("PublicName", "facade.rs", hooks);
    assert.ok(result);
    assert.equal(result.resolvedFile, "internal.rs");
    assert.equal(result.resolvedName, "InternalName");
    assert.equal(result.depth, 1);
  });

  it("detects a cycle without infinite loop", () => {
    const hooks = hooksFromObjectForTesting({
      "a.py": [{ exportedName: "X", targetFile: "b.py", targetName: "X" }],
      "b.py": [{ exportedName: "X", targetFile: "a.py", targetName: "X" }],
    });
    const result = followBarrelChain("X", "a.py", hooks);
    assert.ok(result);
    // Cycle detection: returns when we see a previously-visited file.
    // The exact resolved file at cycle-break is implementation-defined,
    // but visited should include both 'a.py' and 'b.py' and depth must
    // not exceed MAX_BARREL_DEPTH.
    assert.ok(result.depth <= MAX_BARREL_DEPTH);
    assert.ok(result.visited.includes("a.py"));
    assert.ok(result.visited.includes("b.py"));
  });

  it("respects MAX_BARREL_DEPTH on a long linear chain", () => {
    const reExports: Record<string, ReExport[]> = {};
    for (let i = 0; i < MAX_BARREL_DEPTH + 5; i++) {
      reExports[`f${i}.py`] = [
        { exportedName: "X", targetFile: `f${i + 1}.py`, targetName: "X" },
      ];
    }
    reExports[`f${MAX_BARREL_DEPTH + 5}.py`] = [];
    const hooks = hooksFromObjectForTesting(reExports);
    const result = followBarrelChain("X", "f0.py", hooks);
    assert.ok(result);
    assert.ok(
      result.depth <= MAX_BARREL_DEPTH,
      `depth ${result.depth} exceeded MAX_BARREL_DEPTH ${MAX_BARREL_DEPTH}`,
    );
  });

  it("hooksFromMap delegates to a Map cleanly", () => {
    const map = new Map<string, ReExport[]>();
    map.set("entry.ts", [
      { exportedName: "Foo", targetFile: "real.ts", targetName: "Foo" },
    ]);
    map.set("real.ts", []);
    const hooks = hooksFromMap(map);
    const result = followBarrelChain("Foo", "entry.ts", hooks);
    assert.ok(result);
    assert.equal(result.resolvedFile, "real.ts");
  });
});
