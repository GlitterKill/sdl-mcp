# Ladybug Windows OpenSSL runtime

SDL temporarily provisions OpenSSL for LadybugDB FTS on Windows x64 until upstream proves a clean install no longer needs it. This is a workaround for LadybugDB 0.18.1 only; SDL still uses the official `@ladybugdb/core` package and does not rebuild Ladybug.

Supported tuple:

- OS/CPU: Windows x64
- LadybugDB: 0.18.1
- SDL runtime package: `@sdl-mcp/ladybug-openssl-win32-x64@3.5.7-sdl.1`
- Corrected runtime build target: `@sdl-mcp/ladybug-openssl-win32-x64@3.5.7-sdl.2`
- OpenSSL: 3.5.7, `VC-WIN64A shared`
- Source: `https://github.com/openssl/openssl/releases/download/openssl-3.5.7/openssl-3.5.7.tar.gz`
- Source SHA-256: `a8c0d28a529ca480f9f36cf5792e2cd21984552a3c8e4aa11a24aa31aeac98e8`
- Release signer fingerprint: `BA5473A2B0587B07FB27CF2D216094DFD0CB81EF`
- License: Apache-2.0, shipped as `OPENSSL-LICENSE.txt`
- Package provenance: npm provenance plus `provenance.json` and `sbom.spdx.json`

The OpenSSL 3.5.7 archive is signed by OpenSSL's previous official release key, fingerprint `BA5473A2B0587B07FB27CF2D216094DFD0CB81EF`. The published `3.5.7-sdl.1` metadata incorrectly named the newer OpenSSL release key even though signature verification succeeded through a multi-key bundle. The `3.5.7-sdl.2` build contract corrects the signer metadata, commits only the actual signing key, and rejects any `VALIDSIG` fingerprint other than the pinned value. Keep SDL's runtime dependency on `3.5.7-sdl.1` until `3.5.7-sdl.2` is built, published, and registry-verified; then update the exact root pin and cut an SDL patch release.

## Why SDL supplies two DLLs

The official LadybugDB 0.18.1 Windows FTS extension imports `libcrypto-3-x64.dll` and `libssl-3-x64.dll`, but the extension artifact does not ship them. Ladybug loads the extension with plain `LoadLibraryW`. Windows does not search the plugin directory for dependent DLLs in that path, so copying the DLLs beside `libfts.lbug_extension` is insufficient.

Upstream tracker: [LadybugDB/ladybug#685](https://github.com/LadybugDB/ladybug/issues/685).

SDL loads the verified package DLLs by absolute path immediately before `LOAD EXTENSION fts`:

1. verify `package.json` version and `provenance.json` hashes;
2. call the SDL native addon to load `libcrypto-3-x64.dll`, then `libssl-3-x64.dll` with `LoadLibraryExW(..., LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_DEFAULT_DIRS)`;
3. confirm native-reported module origins are inside the package `bin` directory;
4. call Ladybug `LOAD EXTENSION fts`;
5. release preload handles in reverse order.

SDL must not mutate global `PATH`, call `SetDllDirectory`, write into Ladybug's extension cache, or use Git/Conda/OpenSSL machine installs as runtime dependencies.

## Verification

To verify an installed Windows runtime:

1. Compare `bin/libcrypto-3-x64.dll` and `bin/libssl-3-x64.dll` SHA-256 values with `node_modules/@sdl-mcp/ladybug-openssl-win32-x64/provenance.json`.
2. Run the Windows FTS compatibility test in `fixed-regression` mode.
3. Confirm the native loader reports both module paths under the OpenSSL package `bin` directory.
4. Confirm the test reaches `mutation`, `patchSavedFile`, and `shutdown` phases.

`@ladybugdb/core` is a required SDL dependency. Its matching platform binary is a transitive optional dependency, so npm's recursive `--omit=optional` mode is unsupported because it removes the database binary itself. To exercise the supported degraded boundary, set `SDL_MCP_DISABLE_NATIVE_ADDON=1`; a disabled/incompatible native addon, missing runtime package files, or hash mismatches disable only FTS-backed capability and should report recovery guidance instead of crashing startup.

## Recovery

- Missing `libssl-3-x64.dll` or `libcrypto-3-x64.dll`: reinstall `sdl-mcp` with optional dependencies enabled.
- Invalid hashes or missing provenance: reinstall; do not copy DLLs from Git, Conda, or a system OpenSSL install.
- Missing or old `sdl-mcp-native`: reinstall optional dependencies or update `sdl-mcp-native` to the same SDL release.
- Unsupported Windows architecture: FTS runtime provisioning is Windows x64 only.
- Official FTS extension missing or incompatible: rerun the clean-environment compatibility test and keep the 0.16.1 fallback until the gate passes.

## Security update response

The weekly OpenSSL monitor checks official OpenSSL release/advisory sources and runs `npm audit --omit=dev`. npm audit cannot see CVEs in SDL-built DLLs, so the release/advisory check is the authoritative early-warning path.

When it opens an issue:

1. Assess whether the advisory affects the Windows FTS runtime DLLs.
2. Update `ladybug-openssl/source.json` and bump the `-sdl.N` package suffix.
3. Rebuild from official signed OpenSSL source.
   The build must compare GPG's `VALIDSIG` fingerprint with `releaseSignerFingerprint`; checking only that a trusted key bundle contains the fingerprint is insufficient.
4. Rerun OpenSSL tests and the Ladybug clean-environment FTS tests.
5. Publish the runtime package with npm provenance.
6. Update SDL's exact optional OpenSSL runtime pin and lockfile.
7. Cut an SDL patch release.
8. Verify registry tarball hashes and native-reported module origins.

## Upstream removal gate

Remove SDL provisioning only when all are true:

1. A newer official `@ladybugdb/core` and official FTS extension are selected.
2. `SDL_TEST_DISABLE_OPENSSL_PROVISIONING=1` passes on a clean Windows runner.
3. Upstream uses a correct load-directory strategy, a self-contained/static extension, or another proven runtime-resolution fix. Copying DLLs beside a plugin still loaded with plain `LoadLibraryW` is not enough.
4. Repeated FTS update/delete/query and the mandatory `patchSavedFile()` subprocess regression pass.
5. The upstream Ladybug issue is closed with a release reference.
6. Normal and native-addon-disabled packed-install tests pass after removing SDL provisioning.
7. The SDL OpenSSL package and Windows preload API are removed only if no other consumer remains.

## Deletion checklist for the future removal PR

Delete only workaround-owned pieces:

- root optional dependency and lock entry for `@sdl-mcp/ladybug-openssl-win32-x64`;
- `src/db/ladybug-windows-fts-runtime.ts` and its unit test;
- `native/src/windows_loader.rs`, napi exports, and native loader tests if unused;
- native package version/pin changes that exist only for the shim;
- `ladybug-openssl/` package sources and staging metadata;
- build, verify, publish, and monitor workflows that exist only for this workaround;
- troubleshooting text that no longer applies.

Keep the clean-environment FTS subprocess regression and the historical design record.
