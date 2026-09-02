# Ladybug OpenSSL 3.5.8 Runtime Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish the signed Windows Ladybug FTS OpenSSL 3.5.8 runtime and pin it in SDL-MCP 0.13.7.

**Architecture:** Reuse the existing immutable GitHub Actions build and provenance workflow. Publish the runtime first, then resolve the exact SDL dependency and release SDL from a second commit.

**Tech Stack:** PowerShell, OpenSSL 3.5.8, GnuPG, Node.js 24, node:test, npm provenance, GitHub Actions.

---

## Chunk 1: Runtime package

### Task 1: Update the signed-source contract test first

**Files:**

- Modify: `tests/integration/ladybug-openssl-package-contract.test.ts`

- [ ] Expect OpenSSL `3.5.8`, package `3.5.8-sdl.1`, official SHA-256 `a8f84a39918ec6415ce765d9b429d313ba97b8143169c172e734b9514464f5b2`, signing subkey `C46ED3F2CBEFDA1FDAADA44264ED7B1DCCE71CB2`, and primary certificate `B146647E45A7B33947AB226B2A2C87D161692D40`.
- [ ] Assert the publish workflow version equals `source.packageVersion`.
- [ ] Assert the Ladybug FTS import fixture matches the root `kuzu` alias version so driver and artifact coverage cannot drift.
- [ ] Run the focused contract file and confirm the expected RED failures.

### Task 2: Update the runtime source and trust material

**Files:**

- Modify: `ladybug-openssl/source.json`
- Modify: `ladybug-openssl/keys/openssl-release.asc`
- Modify: `ladybug-openssl/npm/win32-x64/package.json`
- Modify: `.github/workflows/publish-ladybug-openssl.yml`
- Modify: `scripts/build-ladybug-openssl-runtime.ps1`

- [ ] Pin the official 3.5.8 URLs, SHA-256, signing subkey, and current primary certificate.
- [ ] Replace the stale 0.18.1 FTS fixture with verified 0.19.0 extension metadata; versioned extension URLs are mutable, so fetch through a deterministic `sha256` query parameter keyed by the pinned artifact hash.
- [ ] Set the package/workflow version to `3.5.8-sdl.1`.
- [ ] Verify both committed certificate fingerprints before accepting the detached signature.
- [ ] Run the focused contract test and confirm GREEN.

### Task 3: Build, verify, and publish the runtime

- [ ] Commit and push only the planned runtime changes.
- [ ] Dispatch `publish-ladybug-openssl.yml` with `dry_run=true` at the immutable commit.
- [ ] Inspect the build, OpenSSL tests, package verification, current Ladybug 0.19.0 FTS test, pack manifest, and hashes.
- [ ] Dispatch the same workflow with `dry_run=false` only after dry-run success.
- [ ] Verify npm metadata, tarball hash, signatures, provenance subject, and workflow commit.

## Chunk 2: SDL pin and patch release

### Task 4: Update SDL's exact runtime pin test first

**Files:**

- Modify: `tests/unit/ladybug-windows-fts-runtime.test.ts`
- Modify: `tests/unit/release-publish-lockfile.test.ts`

- [ ] Expect `3.5.8-sdl.1` and make `3.5.7-sdl.2` the rejected retired runtime fixture.
- [ ] Confirm the new fixture expectations fail against the old loader and dependency metadata.

### Task 5: Pin the published runtime

**Files:**

- Modify: `src/db/ladybug-windows-fts-runtime.ts`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `.github/workflows/ladybug-windows-fts-compat.yml`
- Modify: `CHANGELOG.md`

- [ ] Set all exact runtime pins to `3.5.8-sdl.1` and regenerate the lockfile from npm.
- [ ] Add the security maintenance release note without unrelated refactoring.
- [ ] Run focused tests, build, typecheck, lint, and the full suite required by the package change.
- [ ] Run the clean-environment FTS probe and verify both native-reported DLL origins are inside the installed runtime package.

### Task 6: Release SDL-MCP 0.13.7

- [ ] Generate complete release notes from the full `v0.13.6..HEAD` range and validate commit coverage.
- [ ] Bump synchronized package versions to `0.13.7` and run `npm run prepare-release -- --base-tag v0.13.6`.
- [ ] Commit, create the annotated tag, build immutable release notes, push, and create the GitHub Release.
- [ ] Reinstall registry SDL `0.13.7` in a clean environment and verify both native-reported DLL origins lie inside registry runtime `3.5.8-sdl.1`.
