# CodeQL Status Warning Remediation Design

**Date:** 2026-08-29
**Status:** User-approved; pending written-spec review

## Objective

Replace GitHub's automatic CodeQL setup with one repository-owned advanced
workflow that preserves scanning of production-relevant languages while
excluding intentionally standalone Rust fixtures from semantic extraction.
The change must clear both reported tool-status warning groups without editing
test fixtures or reducing coverage of SDL-MCP's TypeScript and native Rust
implementations.

## Verified Evidence

- The automatic Rust job scans 79 files but reports 10 extraction errors. All
  10 are under `tests/fixtures/rust/**` or
  `tests/stress/fixtures/src/rust/**` and deliberately have no Cargo manifest.
- The automatic C# job reports low analysis quality: 69 percent of calls have
  a target and 78 percent of expressions have a known type, below CodeQL's
  85-percent thresholds. Every C# file is a parser or stress-test fixture.
- The automatic Go job cannot resolve the intentionally fake
  `github.com/user/lib` package. Every Go file is a parser or stress-test
  fixture.
- Every C and C++ file is also a parser or stress-test fixture. Its current job
  reports only the informational `build-mode: none` diagnostic.
- JavaScript/TypeScript is SDL-MCP's primary implementation, Rust contains the
  native addon, Python includes maintained helper scripts outside fixtures, and
  Actions contains the repository's CI and release workflows. These four
  languages remain in scope.
- `GlitterKill/sdl-mcp` is user-owned. GitHub's repository-property mechanism
  for applying a configuration file to default setup is therefore unavailable,
  so path exclusions require advanced setup.

## Workflow Design

Add one file, `.github/workflows/codeql.yml`, using the repository's existing
major-version action convention:

- run on pushes and pull requests targeting `main`, plus a weekly schedule;
- grant only `contents: read`, `actions: read`, and `security-events: write`;
- use a fail-independent matrix for `actions`, `javascript-typescript`,
  `python`, and `rust`;
- use `build-mode: none`, which supports path filtering for these languages;
- initialize CodeQL with an inline configuration that ignores only
  `tests/fixtures/rust/**` and `tests/stress/fixtures/src/rust/**`;
- analyze with the explicit category `/language:${{ matrix.language }}` so the
  advanced results replace the existing automatic categories cleanly.

Do not add Cargo manifests, edit fixture contents, introduce dependencies, or
scan fixture-only C, C++, C#, and Go sources. Those choices would either alter
the fixtures' intended test contract or spend jobs producing diagnostics that
cannot represent production risk.

## Activation Boundary

Local implementation creates and validates the workflow only. It does not push
the commit or change GitHub's current default-setup state.

Publication requires a separate explicit authorization because GitHub requires
default setup to be disabled before advanced setup takes ownership. Once
authorized, keep the transition bounded:

1. Prepare the reviewed workflow commit locally.
2. Disable default setup immediately before pushing that commit.
3. Monitor the first advanced run through all four matrix jobs.
4. Re-enable default setup if the advanced workflow cannot upload complete
   results.

## Verification

Before publication:

- parse the workflow as YAML;
- confirm its matrix, permissions, triggers, categories, and exact ignore paths;
- run `git diff --check` and inspect the complete workflow diff.

After publication:

- require successful Actions, JavaScript/TypeScript, Python, and Rust jobs;
- confirm production files under `src/**`, `native/**`, `scripts/**`,
  `sdlbench/**`, and `.github/workflows/**` remain covered as applicable;
- confirm the 10 standalone Rust fixtures are absent from Rust extraction;
- confirm the C# low-quality, Go missing-package, and Rust extraction-error
  warnings no longer appear on the CodeQL tool-status page.

No product test suite or public runtime documentation changes are required: the
change affects repository security automation only. This design and the
workflow's narrow inline comments document the operational contract.

## Success Criteria

- Both linked automatic-configuration warning groups are resolved.
- CodeQL continues to scan all production-relevant JavaScript/TypeScript,
  Rust, Python, and GitHub Actions source.
- Fixture-only language jobs and intentionally non-buildable Rust fixtures no
  longer distort analysis-quality status.
- The implementation changes one workflow file, adds no dependency, and does
  not modify product or fixture code.
- No push or live security-setting mutation occurs without separate approval.
