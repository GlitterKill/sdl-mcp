---
name: release-notes
description: Generate a CHANGELOG.md entry from git history since the last tag, categorized by type (features, fixes, security, breaking changes). Matches the existing CHANGELOG format.
disable-model-invocation: true
---

# Release Notes Generator

Generate a CHANGELOG entry for the next release by analyzing the complete release range and preserving its validated target through publication.

## Steps

1. **Set the release identities**:
   - Read `<version>` from `package.json`.
   - Set `<tag>` to `v<version>`.
   - Set `<baseTag>` to the previous annotated release tag.
   - Set the pre-release `<target>` to `HEAD`.

2. **Read the complete history**:
   Use the complete, unbounded `<baseTag>..<target>` range with full commit OIDs. Do not add `-n`, `--max-count`, date limits, paging limits, or manual truncation.
   ```bash
   git log <baseTag>..<target> --format="%H%x09%an%x09%s"
   ```

3. **Categorize every commit** into these sections, matching the existing `CHANGELOG.md` style:
   - **Breaking Changes** — API changes, removed features, migration required
   - **Features** — new tools, new CLI commands, new capabilities
   - **Enhancements** — improvements to existing functionality
   - **Bug Fixes** — corrections to incorrect behavior
   - **Security** — vulnerability fixes, hardening
   - **Performance** — speed, memory, or token efficiency improvements
   - **Internal** — refactoring, test infrastructure, CI changes (only include if significant)

4. **Draft concise, grouped summaries**:
   Read the existing `CHANGELOG.md` and group related commits into one visible bullet. Put the full OIDs covered by that bullet in the immediately following hidden marker:
   ```markdown
   - **component**: Concise description of the related change.
     <!-- release-note-commits: <full-oid> <full-oid> -->
   ```
   Use only full 40-character OIDs. Keep exactly one visible commit appendix in the generated release notes, and do not repeat per-commit bullets elsewhere.

5. **Present the CHANGELOG draft for review**:
   Omit empty sections and match the existing heading, bullet, and date style. Do not write `CHANGELOG.md` until the user approves.

6. **Validate before the expensive release checks**:
   After the approved entry is in the working-tree `CHANGELOG.md`, run:
   ```bash
   npm run prepare-release -- --base-tag <baseTag>
   ```
   Save the full `preReleaseTargetOid` from the machine-readable validation output. Stop on any coverage or target drift failure.

7. **Create the release commit and annotated tag**:
   Commit only the approved release changes, then create the annotated tag:
   ```bash
   git tag -a <tag> -m "Release <tag>"
   ```

8. **Build release notes from the tagged target**:
   Immediately after annotated tag creation, run build mode with the exact validated identities:
   ```bash
   node scripts/build-release-notes.mjs build --version <version> --base-tag <baseTag> --target <tag> --pre-release-target <preReleaseTargetOid> --output <output>
   ```
   Do not publish if this command reports coverage or target drift.

9. **Publish the generated file**:
   Push the annotated tag only after build mode passes, then publish the exact generated notes file:
   ```bash
   gh release create <tag> --verify-tag --notes-file <output>
   ```

## Rules

- Analyze the complete, unbounded release range.
- Omit empty sections.
- Use `**component**:` prefixes matching the changed area.
- Keep summaries concise and grouped; never expose coverage markers as visible prose.
- Preserve full-OID coverage from validation through the tagged build.
- Stop at every validation failure; never regenerate against a drifting target.
