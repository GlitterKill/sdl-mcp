# CodeQL Status Warning Remediation Design

**Date:** 2026-08-29
**Status:** User-approved and independently reviewed; awaiting implementation planning

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
- GitHub currently reports `main` as the repository's only protected branch.
  The advanced workflow must recheck this before publication and preserve any
  protected branches added later.

## Workflow Design

Add one file, `.github/workflows/codeql.yml`, using the repository's existing
major-version action convention:

- run on pushes and pull requests targeting `main`, the only currently
  protected branch, plus a weekly schedule;
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
default setup to be disabled before advanced setup takes ownership. That
authorization must cover the push, live setup changes, rollback actions, and
deletion of the two stale automatic configurations; none are implied by local
implementation approval.

Before cutover, capture the current default-setup configuration, confirm that
`main` remains the only protected branch, and prepare the reviewed workflow
commit locally. Once authorized, keep the transition bounded:

1. Disable default setup immediately before pushing the prepared commit. If
   the push fails, re-enable default setup immediately and require a successful
   replacement scan.
2. Require the advanced run to start within five minutes. Require all four
   matrix jobs and their SARIF uploads to complete successfully within 20
   minutes.
3. If the run does not start, times out, is cancelled, or any job or upload
   fails, disable or revert the advanced workflow, re-enable default setup,
   trigger a replacement scan, and do not end rollback until that scan passes.
4. After the advanced run and analyzed-files checks pass, delete only the stale
   automatic configurations identified by hashes
   `992cdcf08f7eda28cb86fe9e8b79aff393ece38113384141a147527029fa11ed`
   and
   `e9917bfbf66c6fe35a7723d990927ccd12570e4f46fd53426fd3a334fa0b10f4`.
   Verify immediately beforehand that neither configuration owns an open alert,
   and do not delete an advanced configuration.

## Verification

Before publication:

- parse the workflow as YAML;
- confirm its matrix, permissions, triggers, categories, and exact ignore paths;
- run `git diff --check` and inspect the complete workflow diff.

After publication:

- require successful Actions, JavaScript/TypeScript, Python, and Rust jobs;
- download the analyzed-files report and compare its paths and extraction
  status with tracked source files;
- require every tracked JavaScript/TypeScript and Python source file and every
  tracked GitHub Actions workflow or action definition to report successful
  extraction;
- require every tracked Rust file outside `tests/fixtures/rust/**` and
  `tests/stress/fixtures/src/rust/**` to report successful extraction;
- require exactly the 10 known standalone Rust fixtures to be excluded, with no
  other Rust source lost;
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
