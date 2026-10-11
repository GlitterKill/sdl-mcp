# Ladybug Windows OpenSSL runtime

SDL temporarily provisions OpenSSL for LadybugDB FTS on Windows x64 until upstream proves a clean install no longer needs it. This is a workaround for LadybugDB 0.19.0 only; SDL still uses the official `@ladybugdb/core` package and does not rebuild Ladybug.

Current SDL runtime pin:

- OS/CPU: Windows x64
- LadybugDB: 0.19.0
- SDL runtime package: `@sdl-mcp/ladybug-openssl-win32-x64@3.5.8-sdl.1`
- OpenSSL: 3.5.8, `VC-WIN64A shared`
- Source: `https://github.com/openssl/openssl/releases/download/openssl-3.5.8/openssl-3.5.8.tar.gz`
- Source SHA-256: `a8f84a39918ec6415ce765d9b429d313ba97b8143169c172e734b9514464f5b2`
- Release signer fingerprint: `C46ED3F2CBEFDA1FDAADA44264ED7B1DCCE71CB2`
- License: Apache-2.0, shipped as `OPENSSL-LICENSE.txt`
- Package provenance: npm provenance plus `provenance.json` and `sbom.spdx.json`

A 3.5.9-sdl.1 staging candidate was locally qualified on 2026-10-07 from the
verified, signed official 3.5.9 archive. OpenSSL's suite passed 4,283 tests across
347 files; the candidate passed clean-environment LadybugDB 0.19.0 FTS mutation
checks, all eight package-contract tests, and native DLL-origin checks with only
the Windows system directory on PATH. The verifier generated fresh provenance
and SBOM files from the built DLLs. The candidate is unpublished and not selected
by the runtime. Installations remain on 3.5.8-sdl.1 pending provenance-backed
publication, exact dependency and loader pin updates, and installed-package
regressions.

## 3.5.9 adoption and qualification gates

The staged package and publish workflow select `3.5.9-sdl.1`. The root dependency,
lockfile, and `WINDOWS_FTS_RUNTIME_PACKAGE_VERSION` deliberately retain the
published `3.5.8-sdl.1` until the new runtime is available from npm. The loader,
recovery text, fixture preflight, and compatibility workflow now share or derive
the selected version; a unit test checks it against the root dependency.

Avoid `--no-package-lock` in a lockfile-backed qualification checkout: it can
re-resolve unrelated dependency ranges. Preserve the committed graph while
replacing the dependency-free runtime package, and use a separate fresh consumer
for normal npm packed-install checks.

Qualification must test a locally packed candidate with a temporary matching
root dependency and loader constant. Do not publish this temporary SDL tarball
or commit a lockfile pointing to a local tarball. After publishing the runtime
with provenance, verify its registry tarball against the qualified artifact,
change the root optional dependency and loader constant together, and regenerate
the lockfile using `npm install --package-lock-only --ignore-scripts --legacy-peer-deps`.
Review the lockfile for unrelated resolution changes before proceeding.

The verifier and Windows fixtures now check the *installed* FTS cache artifact
inside each isolated home after `INSTALL`, before `LOAD`, and after use. The
production-reopen fixture seeds and verifies the pinned artifact before database
initialization can auto-load it. The shared helper checks confinement, size,
and SHA-256; a separate downloaded file is not evidence of the loaded cache file.
Successful compatibility logs include the FTS digest and native-reported DLL
origins. The release smoke harness must copy the helper and FTS contract as well
as the fixture. Production SDL does not change the user's extension cache.

The pinned 0.19.0 Windows FTS artifact is 14,809,088 bytes, SHA-256
`27adf2ca87ec5a5871a91c3864a3353a7d4aa5808f5729f34a6c21cbb500eaf0`.
On 2026-10-08 the GK user's existing cache contained a different 14,779,904-byte
artifact (`7f82059c8149bb7851420a9bfd0c46859e92efaeda0bcd5c65418d8f174edac4`).
That cache was preserved; its exact provenance remains unresolved. Candidate
qualification uses new isolated homes and must not silently bless the old cache.

Release gates are: signed-source build and full OpenSSL suite; package allowlist,
provenance, SBOM, imports/exports and architecture checks; actual-cache digest;
System32-only PATH with cleared OpenSSL variables; DLL-origin checks; repeated
FTS create/update/delete/query and `patchSavedFile`; database reopen in fresh
processes; normal packed installation and native-disabled MCP startup; and the
repository's ordinary build, lint, typecheck, config, aggregate and audit gates.
An expected no-provisioning failure is not a successful upstream-removal test.
Hosted Windows CI and registry provenance remain required even after local tests.

Rollback before publication means discarding the temporary adoption edits and
returning the installed runtime and compiled output to 3.5.8. After an SDL release,
rollback uses a new SDL patch release restoring the prior exact dependency,
loader constant and lockfile, with the same packed-install checks. npm versions
are immutable; do not replace an existing runtime tarball.

### Local qualification on 2026-10-08

Implementation branch: `codex/issue-58-openssl-3-5-9`, based on
`383bbdabdc9e1b0b7ff61bd60cb1507bcbb033b0`. This is an unpublished candidate.

Actually run on Windows x64 with Node 24.14.0:

- Fresh signed-source OpenSSL build: 4,283 tests across 347 files, PASS, with
  upstream platform/locale skips recorded in the build log.
- Staged PE/import/export, source signature, provenance, package allowlist and
  actual-installed-FTS checks: PASS. Package contracts: 8/8. Artifact rejection
  tests: 5/5. Runtime boundary/version/reopen tests: 16/16.
- Candidate System32-only-PATH regression: 25 FTS mutation iterations, search
  and deletion assertions, `patchSavedFile`, clean shutdown and real DLL origins:
  PASS. The no-provisioning probe still requires SDL's workaround.
- Clean npm installation from local SDL, native and runtime tarballs: PASS;
  optional dependencies were enabled, model download and interactive setup were
  skipped. Parser verification, expected missing-runtime baseline, full FTS
  regression, two fresh-process database reopens, and native-disabled MCP startup
  all passed. Repeated after correcting the SBOM format.
- `build:all`, typecheck, config sync and lint: PASS (lint: 522 warnings, 0 errors).
- `npm test`, both published and candidate runtime selections: 764/772 files
  passed; the same eight base failures reproduced independently. The final SBOM
  correction was followed by focused package tests and a fresh packed install;
  the aggregate results predate that metadata-only correction.
- The final SBOM is real SPDX 2.3 JSON and passed the official schema, plus
  content checks for shipped-file hashes and package verification code.

Final local artifact SHA-256 values:

| Artifact | SHA-256 |
| --- | --- |
| `libcrypto-3-x64.dll` | `6c39383e146b7cb96e7da94fc8d3df7a9651e01046878fefadfcdc78511f499c` |
| `libssl-3-x64.dll` | `81b226403a019f3ecabf69943b7fa1f9970a90f410fc72a6fcdab493d1a305f9` |
| Runtime npm tarball | `479e93b844f463bc898bfb21d8493e5f775fb0d8f02b66ed05ebf904f5792817` |

The ordinary root manifest, lockfile, installed runtime and compiled loader were
returned to 3.5.8-sdl.1 after qualification. The local SDL tarball is a test
artifact with a temporary candidate pin, not an approved 0.13.7 release.

Gates remaining at the October 8 checkpoint: the eight base test failures, the production audit findings,
the existing lockfile/native-version discrepancies, hosted CI, and provenance-
backed runtime publication followed by a regenerated consumer lockfile. The base
Windows native entry says 0.13.7 but points to the 0.12.4 tarball; two Watchman
entries similarly point to 0.11.8 tarballs. Candidate packed tests used native
packages built from this branch. No unrelated lockfile upgrades were retained.

### Baseline repairs on 2026-10-10

The eight failing files were reproduced before changes. The follow-up fixes
preserve their behavioral checks:

- Overlay evidence checks read cards folded into code evidence and assert the
  exact modified/added symbol IDs, current signatures and removed-symbol exclusion.
- Workflow fixtures expect an error for a missing response handle and assert
  `NOT_FOUND`. Recovery checks retain the schema-valid direct `sdl.retrieve`
  continuation, exact arguments and field order. The projector removes duplicate
  `error.nextCalls` only when it has a validated step-level `nextAction`.
- Discovery checks exercise the current `replaceLines` example through the real
  content transformation for both LF and CRLF, including unchanged trailing text.
- The terminal test isolates and restores `NO_COLOR`, testing both the explicit
  option and environment override. Production color behavior is unchanged.
- The seed-evaluation artifact was regenerated from the current source. Its
  quality results and hard floors are unchanged.
- The two Kotlin failures occurred before their target assertions because the
  native grammar was absent after an earlier scripts-disabled install. A clean
  install with lifecycle scripts enabled restored it; no Kotlin assertion or
  parser implementation was weakened or skipped.

The lockfile had ten mislabeled native/Watchman resolutions, including platforms
not installed on this Windows machine. Their versions remain 0.13.7; only the
tarball URLs and integrity fields were replaced with exact npm registry metadata.
All ten downloaded tarballs passed their registry SHA-512 integrity checks and
contained the expected package name/version. No unrelated dependency was changed.
`sync-native-version.mjs` now updates root version requirements while preserving
complete resolved-package records. Once new versions are published, npm must
resolve their complete metadata. A regression test rejects the former behavior
of combining new version labels with old tarball URLs and hashes.

Clean `npm ci --legacy-peer-deps` passed with optional dependencies enabled,
strict parser verification, and model download/setup prompts disabled. All 478
installed lock entries matched their versions, every grammar loaded, and the
Watchman binary returned its version. All eight targeted test files and the
version-sync/response-projection checks passed.

The corrected installation also established a separate native release gate:
the actual registry `sdl-mcp-native@0.13.7` has the Windows loader but lacks
`parseContent` and `parserIdentityContractVersion`. This is now verified against
the correct 0.13.7 artifacts, rather than inferred from the former 0.12.4
resolution. The previously qualified branch-built addon exposes contract 1.
Full Windows FTS qualification must retain that content-parser preflight and use
the branch-built artifact. Registry-based qualification requires a new immutable,
release-coupled native version containing these APIs; do not overwrite 0.13.7 or
claim that changing lock metadata supplies missing exports.

The signed OpenSSL build and candidate runtime tarball from October 8 were reused
unchanged. After these repairs, both full aggregate runs passed all 773 test
files with zero failures and zero segfault-on-exit classifications: one using
the published OpenSSL 3.5.8 runtime and one using the verified 3.5.9 candidate.
These aggregate runs use the repository's normal TypeScript-fallback test setup;
they do not certify the registry native parser contract. Required Windows FTS
regressions passed with both runtime versions and the branch-built addon.
The separate registry-native preflight failed as expected on the missing parser
contract and remains a release blocker.

Typecheck, lint (zero errors; existing warnings retained), configuration sync,
golden validation and a fresh packed candidate install passed. The packed install
used the local branch-built native tarballs, not the registry-native binary.
It passed parser verification, the missing-runtime baseline, full FTS mutation
and patchSavedFile checks, two independent database reopens, and native-disabled
MCP startup. Installed candidate files matched their SBOM and DLL provenance.
The worktree's root manifest, installed runtime and compiled loader were restored
to 3.5.8-sdl.1; the corrected native/Watchman lock metadata was retained.
Generated test-fixture edits were archived separately and restored to their
pre-test bytes. Hosted Windows/Linux and non-Windows native execution remain
external validation gates. No package was published and no PR was created.

### Native package API repair on 2026-10-10

A direct comparison corrected the diagnosis of the 0.13.7 parser gate: the
registry Windows platform binary already exports parseContent, parseFilesAsync
and parserIdentityContractVersion, and reports contract 1. The handwritten
native/index.js umbrella wrapper omitted these three exports. Rust source and
generated declarations were already correct; no Rust algorithm change was needed.
The wrapper now forwards the actual binding functions. A six-platform loader
regression failed before the repair and passes afterward.

Previous native parser tests preferred a local raw addon. The release packed FTS
test explicitly selected the raw installed platform binary, bypassing the broken
umbrella wrapper. The release packed check now imports the normal umbrella,
verifies required exports, version agreement, installed binary origin and
content/disk/async parity, and runs FTS without an addon override. The independent
native publisher also packs and installs its same-run Linux x64 GNU artifact and
umbrella on Ubuntu x64 and must pass the contract before either publish step.
The package qualifier invokes npm through Node, without a shell, and also passed
with spaces in the clean consumer path.

Local candidates sdl-mcp-native@0.13.8-rc.1 and
sdl-mcp-native-win32-x64-msvc@0.13.8-rc.1 were freshly packed and installed.
Both version names returned registry 404 before staging. A separate disposable
SDL 0.13.8-rc.1 package was used only to verify that dependency adoption; its
native pin selects the candidate. Source manifests and the lockfile retain the
published 0.13.7 native/Watchman versions and OpenSSL 3.5.8-sdl.1. Candidate
version changes occur only in staging directories, so normal npm ci remains
coherent. No package was published, and published 0.13.7 remains unchanged.

Actual local checks passed: native rebuild; four focused Rust content tests;
three native JS content/parity/deep-input tests; 37 native hash/symbol-ID parity
checks; loader/workflow regression checks; typecheck, lint (522 warnings, zero
errors), config sync, workflow YAML parsing; and all 774 aggregate test files,
with zero segfault-on-exit classifications. The freshly installed SDL consumer
reported native:1 from sdl-mcp-native with no local-addon override, passed parser
and grammar verification, FTS mutation/patchSavedFile using OpenSSL 3.5.8, two
independent database reopens, and native-disabled MCP startup. Its install
reported 12 audit findings (9 moderate, 3 high); this is a separate snapshot from
the root lockfile audit and is not fixed by the wrapper change.

Remaining gates: hosted Windows/Linux checks, execution of the other platform
binaries, complete release-coupled version selection, registry publication and
verification of the new immutable artifacts, and existing dependency audit
findings. Local packed success does not certify an unpublished registry version.

### Advisory applicability

[OpenSSL 3.5.9 release notes](https://openssl-library.org/news/openssl-3.5-notes/)
and the [29 September advisory](https://openssl-library.org/news/secadv/20260929.txt)
justify updating the bundled library. The high-severity DTLS issue
`CVE-2026-84782`, the other DTLS issue, and QUIC fixes have no demonstrated path
through ordinary local FTS indexing/querying. CRLDP certificate processing and
TLS context-switch behavior require their specific TLS/X.509 paths; EC/SM2
timing and CMP fixes require those algorithms/protocols. The ARM64/RISC-V-only
SM2 finding is inapplicable to this Windows x64 package. The X.509 cache issue
`CVE-2026-84783` affects OpenSSL 4.0, not the selected 3.5 branch.

The inspected Ladybug 0.19.0 source (`c934f673b6b1c5b680bdae3295cbd909b5855cef`,
extension submodule `104501f627e17eff6826ca8406ef7d1a2784f8d9`) had no direct
SSL/HTTP calls in the FTS source files. These are reachability observations,
not proof that all transitively linked code is unreachable. Importing a DLL or
finding a vulnerable version alone does not establish an exploitable FTS path.
Updating the DLLs still removes vulnerable implementations from the distribution.

The Node addon also imports OpenSSL APIs from `node.exe`; that runtime is distinct
from the DLLs imported by the FTS extension. GK's tested Node 24.14.0 reports
embedded OpenSSL 3.5.5. This candidate does not update Node or fix vulnerabilities
in its embedded OpenSSL. Host-runtime maintenance remains a separate action.

### Separate production audit finding

The 2026-10-08 `npm audit --omit=dev` snapshot reports 12 findings: 7 moderate,
4 high and 1 critical. The critical entry is `proxy-addr@2.0.7`, through
`@modelcontextprotocol/sdk@1.29.0 -> express@5.2.1 -> proxy-addr@2.0.7`, already
present in base commit `383bbdabdc9e1b0b7ff61bd60cb1507bcbb033b0` and its lockfile.
It is a production dependency, not a development-only finding, and is not
introduced or fixed by replacing the OpenSSL DLLs.

[CVE-2026-90711 / GHSA-jqcg-44mw-7w3h](https://github.com/jshttp/proxy-addr/security/advisories/GHSA-jqcg-44mw-7w3h)
affects proxy trust configured with certain IPv6 subnets. A synthetic local
request reproduced spoofed `X-Forwarded-For` selection with `::ffff:10.0.0.0/8`;
the correctly expressed subnet returned the socket address. SDL's inspected
`src/cli/transport/http.ts` uses Node HTTP, socket addresses for loopback checks
and auth rate-limit keys, and bearer-token authentication. No Express trust-proxy
or proxy-addr call was found on that path. This limits demonstrated reachability;
it does not remove the dependency finding or waive the audit release gate.
External embedding configurations were not tested. Fix unrelated npm findings
in a separate dependency change.

## Why SDL supplies two DLLs

The official LadybugDB 0.19.0 Windows FTS extension imports `libcrypto-3-x64.dll` and `libssl-3-x64.dll`, but the extension artifact does not ship them. Ladybug loads the extension with plain `LoadLibraryW`. Windows does not search the plugin directory for dependent DLLs in that path, so copying the DLLs beside `libfts.lbug_extension` is insufficient.

Upstream tracker: [LadybugDB/ladybug#685](https://github.com/LadybugDB/ladybug/issues/685).

SDL dynamically imports the official package and constructs `Database` before
OpenSSL preloading. It wraps native database initialization and explicit FTS
extension loading with the verified Windows runtime. If provisioning is
unavailable, initialization tries the driver without preloading; explicit FTS
capability retains its recovery diagnostics.

At each protected initialization or FTS-loading boundary, SDL:

1. verify `package.json` version and `provenance.json` hashes;
2. call the SDL native addon to load `libcrypto-3-x64.dll`, then `libssl-3-x64.dll` with `LoadLibraryExW(..., LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_DEFAULT_DIRS)`;
3. confirm native-reported module origins are inside the package `bin` directory;
4. initialize the native database or call Ladybug `LOAD EXTENSION fts`;
5. release preload handles in reverse order.

The dynamic `kuzu` import remains outside the preload callback. This keeps
ordinary database startup non-blocking when the optional Windows runtime is
missing, while the explicit FTS capability still fails with recovery guidance.

SDL must not mutate global `PATH`, call `SetDllDirectory`, write into Ladybug's extension cache, or use Git/Conda/OpenSSL machine installs as runtime dependencies.

## Verification

To verify an installed Windows runtime:

1. Compare `bin/libcrypto-3-x64.dll` and `bin/libssl-3-x64.dll` SHA-256 values with `node_modules/@sdl-mcp/ladybug-openssl-win32-x64/provenance.json`.
2. Run the clean child-process reopen regression and confirm both production reopen attempts exit normally without ambient OpenSSL paths.
3. Run the Windows FTS compatibility test in `fixed-regression` mode.
4. Confirm the native loader reports both module paths under the OpenSSL package `bin` directory.
5. Confirm the test reaches `mutation`, `patchSavedFile`, and `shutdown` phases.

`@ladybugdb/core` is a required SDL dependency. Its matching platform binary is a transitive optional dependency, so npm's recursive `--omit=optional` mode is unsupported because it removes the database binary itself. To exercise the supported degraded boundary, set `SDL_MCP_DISABLE_NATIVE_ADDON=1`; a disabled/incompatible native addon, missing runtime package files, or hash mismatches disable only FTS-backed capability and should report recovery guidance instead of crashing startup.

## Recovery

- Missing `libssl-3-x64.dll` or `libcrypto-3-x64.dll`: reinstall `sdl-mcp` with optional dependencies enabled.
- Invalid hashes or missing provenance: reinstall; do not copy DLLs from Git, Conda, or a system OpenSSL install.
- Missing or old `sdl-mcp-native`: reinstall optional dependencies or update `sdl-mcp-native` to the same SDL release.
- Unsupported Windows architecture: FTS runtime provisioning is Windows x64 only.
- Official FTS extension missing or incompatible: reinstall the pinned LadybugDB and SDL OpenSSL runtime, then rerun the clean-environment compatibility test; keep FTS disabled until it passes.

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
