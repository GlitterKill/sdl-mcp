# Release Summary Coverage Design

## Goal

Every release summary must consider the complete commit range since the previous release while remaining a concise, grouped summary. The existing commit appendix remains the only visible per-commit list.

## Root cause

The release process currently copies the dated `CHANGELOG.md` section into the GitHub Release and appends the full commit range. `prepare-release` verifies that the changelog heading exists, but it does not verify that the grouped summary accounts for every commit or that the published body matches the final tag.

## Inputs and canonical inventory

The tool requires explicit `version`, `baseTag`, and `target` inputs. Publication mode also requires the full `preReleaseTargetOid` emitted by successful pre-release validation.

- Resolve refs through `<ref>^{commit}` so annotated tags identify their commit objects.
- Select only the exact `## [<version>]` changelog section.
- Require a non-shallow repository, existing refs, and `baseTag` as an ancestor of `target`.
- Inventory every commit in `baseTag..target`, including merge commits, without a Git count limit.
- Use a bounded 16 MiB process buffer and fail closed on overflow rather than silently truncating.
- Pre-release validation uses the current full `HEAD` object ID as `target` and emits that OID.
- Publication validation uses the immutable release tag as `target` and requires its tagged commit's sole parent to equal `preReleaseTargetOid`.
- Generate the visible commit appendix from this same inventory.

## Summary coverage contract

1. Group related work into concise visible changelog bullets.
2. Bind every work-bearing commit to exactly one bullet using an adjacent hidden marker with this grammar:
   `  <!-- release-note-commits: <40-hex-object-id>[ <40-hex-object-id>...] -->`
3. Mark only mechanically non-summary commits with:
   `<!-- release-note-omit: <40-hex-object-id> <reason-code> -->`
4. Permit only `merge-only` as an explicit omission code; its commit must have more than one parent, while the merged commits remain independently covered.
5. Permit one implicit unmarked omission only in publication mode: the tagged commit must have exactly one parent equal to `preReleaseTargetOid`, subject `chore: release v<version>`, and changed paths limited to this exact allowlist:
   - `CHANGELOG.md`
   - `package.json`
   - `package-lock.json`
   - `packages/create-sdl-mcp/package.json`
   - `native/package.json`
   - `native/npm/darwin-arm64/package.json`
   - `native/npm/darwin-x64/package.json`
   - `native/npm/linux-arm64-gnu/package.json`
   - `native/npm/linux-x64-gnu/package.json`
   - `native/npm/linux-x64-musl/package.json`
   - `native/npm/win32-x64-msvc/package.json`
   - `watchman/package.json`
   - `watchman/npm/linux-x64/package.json`
   - `watchman/npm/win32-x64/package.json`
6. Require include markers immediately after their summary bullet inside the target version section. Omission markers must also be inside that section.
7. Reject malformed, orphaned, out-of-section, abbreviated, unknown, duplicated, include-plus-omit, or missing object IDs.
8. Keep all markers hidden in rendered Markdown and keep the commit appendix as the only visible per-commit list.

Example source:

```markdown
- **Continuation safety**: Reject untrusted nested repository identifiers and preserve response projections across continuation retrieval.
  <!-- release-note-commits: <full-object-id> <full-object-id> -->

<!-- release-note-omit: <full-object-id> merge-only -->
```

## Implementation

- Add one dependency-free `scripts/build-release-notes.mjs` using `execFileSync` with explicit buffers and a constrained line parser.
- Validation mode checks the exact changelog section and coverage ledger against `version`, `baseTag`, and `target`, then returns `preReleaseTargetOid`.
- Build mode validates the immutable tag and release-commit predicate against `preReleaseTargetOid`, extracts the same grouped section, and appends the one visible commit appendix.
- Invoke validation near the start of `scripts/prepare-release.mjs`, before expensive build and test gates.
- Require the release skills to preserve the emitted OID, run build mode after creating the annotated tag, and pass its output to `gh release create --notes-file`; publication stops on target drift or coverage failure.
- Add one focused `node:test` file. No dependency, AI service, GitHub API wrapper, or second visible commit list is added.
- Update both repository release-note skill copies with the full-range inventory and hidden coverage-ledger procedure.

## Verification

Tests must cover:

- Multiple commits grouped under one visible summary.
- Missing, duplicate, unknown, abbreviated, and include-plus-omit object IDs.
- Malformed, orphaned, and out-of-section markers.
- Invalid omission codes and failed `merge-only` predicates.
- Pre-release `HEAD` validation and annotated final-tag validation through `^{commit}`.
- The valid implicit release-commit exception and failures for target drift, extra parents, wrong subject, or paths outside the allowlist.
- Missing refs, non-ancestor base tags, shallow repositories, and buffer overflow.
- Body construction from the same inventory used by validation, with only one visible commit appendix.

## Boundaries

- The validator proves complete accounting, not prose quality; review still decides whether the grouped wording accurately describes the assigned commits.
- Existing released tags are not rewritten.
- The corrected v0.13.5 GitHub Release body is the historical repair. Automated enforcement begins with the next release prepared after this change.
