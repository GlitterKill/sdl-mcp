# Ladybug OpenSSL 3.5.8 Runtime Design

## Goal

Replace the published Windows x64 Ladybug FTS runtime based on OpenSSL 3.5.7 with a signed, provenance-attested `3.5.8-sdl.1` package, then pin that exact package in SDL-MCP 0.13.7.

## Security assessment

OpenSSL 3.5.8 fixes ten CVEs. The generic Ladybug FTS import contract covers TLS client, digest, and X.509 functions and does not import the affected QUIC server, DTLS, CMS, CMP, RPK, or one-shot `EVP_Cipher` APIs. Direct reachability is therefore not evident. The signed-build workflow also runs the repository's current Ladybug 0.19.0 clean-environment FTS test, so publication remains gated on the driver SDL actually ships. The FTS import fixture follows the root `kuzu` alias at `@ladybugdb/core@0.19.0`; the prior 0.18.1 URL mutated in place on 2026-09-01 and no longer matched its committed hash. The distributed DLLs still contain affected 3.5.7 code and should be replaced.

## Signed build

Reuse `.github/workflows/publish-ladybug-openssl.yml` and `scripts/build-ladybug-openssl-runtime.ps1`. Machine-check the official 3.5.8 source URL, SHA-256 `a8f84a39918ec6415ce765d9b429d313ba97b8143169c172e734b9514464f5b2`, detached signature, signing subkey `C46ED3F2CBEFDA1FDAADA44264ED7B1DCCE71CB2`, and primary certificate `B146647E45A7B33947AB226B2A2C87D161692D40`. Keep the existing full OpenSSL test run, Ladybug clean-environment FTS checks, package allowlist, DLL hashes, PE checks, SBOM, npm provenance, registry tarball comparison, and attestation audit.

## Two publication phases

1. Commit and push the runtime source/signing/test changes. Run the workflow in dry-run mode, inspect its evidence, then publish `@sdl-mcp/ladybug-openssl-win32-x64@3.5.8-sdl.1` from the same immutable commit.
2. After the registry package and provenance are verified, update SDL's exact optional dependency, loader constant, compatibility workflow, lockfile, changelog, and package versions. Run the release gates and publish SDL-MCP 0.13.7.

The split avoids generating a lockfile against an unpublished package and preserves an auditable build identity for both publications.

## Failure handling

Stop before publication if source hash/signature validation, OpenSSL tests, package verification, Ladybug FTS tests, or dry-run evidence fails. Stop before the SDL release if the registry tarball differs from the workflow artifact, provenance validation fails, or the exact clean-environment module origins are outside the runtime package.
