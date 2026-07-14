# Ladybug Windows OpenSSL runtime

SDL temporarily provisions OpenSSL for LadybugDB FTS on Windows x64 until upstream proves a clean install no longer needs it.

## Upstream removal gate

Remove SDL provisioning only when all are true:

1. A newer official `@ladybugdb/core` and official FTS extension are selected.
2. `SDL_TEST_DISABLE_OPENSSL_PROVISIONING=1` passes on a clean Windows runner.
3. Upstream uses a correct load-directory strategy, a self-contained/static extension, or another proven runtime-resolution fix. Copying DLLs beside a plugin still loaded with plain `LoadLibraryW` is not enough.
4. Repeated FTS update/delete/query and the mandatory `patchSavedFile()` subprocess regression pass.
5. The upstream Ladybug issue is closed with a release reference.
6. Normal and `--omit=optional` packed-install tests pass after removing SDL provisioning.
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

## Security update response

The weekly OpenSSL monitor checks official OpenSSL release/advisory sources and runs `npm audit --omit=dev`. npm audit cannot see CVEs in SDL-built DLLs, so the release/advisory check is the authoritative early-warning path.

When it opens an issue:

1. Assess whether the advisory affects the Windows FTS runtime DLLs.
2. Update `ladybug-openssl/source.json` and bump the `-sdl.N` package suffix.
3. Rebuild from official signed OpenSSL source.
4. Rerun OpenSSL tests and the Ladybug clean-environment FTS tests.
5. Publish the runtime package with npm provenance.
6. Update SDL's exact optional-dependency pin and lockfile.
7. Cut an SDL patch release.
8. Verify registry tarball hashes and native-reported module origins.
