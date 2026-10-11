import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateMuslElf } from "../../scripts/verify-musl-elf.mjs";

const validMetadata = `ELF Header:
  Class:                             ELF64
  Type:                              DYN (Shared object file)
  Machine:                           Advanced Micro Devices X86-64

Dynamic section at offset 0x1f000 contains 3 entries:
  0x0000000000000001 (NEEDED)             Shared library: [libc.musl-x86_64.so.1]
  0x0000000000000001 (NEEDED)             Shared library: [libgcc_s.so.1]
`;

function withExtraMetadata(extra: string): string {
  return `${validMetadata}${extra}\n`;
}

describe("musl ELF linkage validation", () => {
  it("accepts an ELF64 x86-64 musl shared object with libgcc", () => {
    assert.deepEqual(validateMuslElf(validMetadata), {
      machine: "x86_64",
      libc: "musl",
      needed: ["libc.musl-x86_64.so.1", "libgcc_s.so.1"],
    });
  });

  it("rejects glibc linkage even when musl libc is also present", () => {
    for (const dependency of [
      "libc.so.6",
      "ld-linux-x86-64.so.2",
    ]) {
      assert.throws(
        () => validateMuslElf(withExtraMetadata(`  0x0000000000000001 (NEEDED) Shared library: [${dependency}]`)),
        assert.AssertionError,
        `${dependency} must be rejected alongside musl libc`,
      );
    }
    assert.throws(
      () => validateMuslElf(withExtraMetadata("Version needs section '.gnu.version_r':\n  Name: GLIBC_2.34")),
      assert.AssertionError,
      "GLIBC version requirements must be rejected alongside musl libc",
    );
  });

  it("rejects non-ELF64, non-shared, and non-x86-64 inputs", () => {
    for (const [field, replacement] of [
      ["Class:                             ELF64", "Class:                             ELF32"],
      ["Type:                              DYN (Shared object file)", "Type:                              EXEC (Executable file)"],
      ["Machine:                           Advanced Micro Devices X86-64", "Machine:                           AArch64"],
    ]) {
      assert.throws(
        () => validateMuslElf(validMetadata.replace(field, replacement)),
        assert.AssertionError,
        `${field} must be qualified`,
      );
    }
  });

  it("rejects a requested executable interpreter", () => {
    assert.throws(
      () => validateMuslElf(withExtraMetadata("  INTERP         0x0000000000000238\n      [Requesting program interpreter: /lib/ld-musl-x86_64.so.1]")),
      assert.AssertionError,
    );
  });

  it("rejects unknown dependencies and binaries without musl libc", () => {
    assert.throws(
      () => validateMuslElf(withExtraMetadata("  0x0000000000000001 (NEEDED) Shared library: [libcrypto.so.3]")),
      assert.AssertionError,
    );
    assert.throws(
      () => validateMuslElf(validMetadata.replace("  0x0000000000000001 (NEEDED)             Shared library: [libc.musl-x86_64.so.1]\n", "")),
      assert.AssertionError,
    );
  });

  it("rejects build-host RPATH and RUNPATH entries", () => {
    for (const entry of ["(RPATH) Library rpath: [/usr/lib]", "(RUNPATH) Library runpath: [/usr/lib]"]) {
      assert.throws(
        () => validateMuslElf(withExtraMetadata(`  0x000000000000001d ${entry}`)),
        assert.AssertionError,
        `${entry} must be rejected`,
      );
    }
  });
});
