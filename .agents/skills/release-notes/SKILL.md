---
name: release-notes
description: Generate a CHANGELOG.md entry from git history since the last tag, categorized by type (features, fixes, security, breaking changes). Matches the existing CHANGELOG format.
disable-model-invocation: true
---

# Release Notes Generator

Generate a CHANGELOG entry for the next release by analyzing git history since the last tag.

## Steps

1. **Get the last tag and version**:
   ```bash
   git describe --tags --abbrev=0
   ```
   Also read the current version from `package.json`.

2. **Get all commits since the last tag**:
   ```bash
   git log <last-tag>..HEAD --oneline --no-merges
   ```

3. **Categorize each commit** into these sections (matching the existing CHANGELOG.md format):
   - **Breaking Changes** — API changes, removed features, migration required
   - **Features** — new tools, new CLI commands, new capabilities
   - **Enhancements** — improvements to existing functionality
   - **Bug Fixes** — corrections to incorrect behavior
   - **Security** — vulnerability fixes, hardening
   - **Performance** — speed, memory, or token efficiency improvements
   - **Internal** — refactoring, test infrastructure, CI changes (only include if significant)

4. **Read the existing CHANGELOG.md** to match its formatting style (heading levels, bullet format, date format).

5. **Draft the entry** in this format:
   ```markdown
   ## [X.Y.Z] - YYYY-MM-DD

   ### Features
   - **tool-name**: Description of what was added

   ### Bug Fixes
   - **component**: What was fixed and why

   ### Security
   - **component**: What vulnerability was addressed
   ```

6. **Present the draft** to the user for review. Do NOT write it to CHANGELOG.md until the user approves.

## Rules

- Omit empty sections (don't include "### Internal" if there are no internal changes)
- Use `**component**:` prefix on each bullet matching the area of code changed
- Keep descriptions concise (one line each)
- Group related commits into single bullets when they address the same change
- Include the commit count summary at the end: `_N commits from M contributors_`
