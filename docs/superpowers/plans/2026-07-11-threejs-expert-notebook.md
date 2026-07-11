# Three.js Expert Markdown Notebook Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Three.js expert's Claude-managed memory with a private, typed Markdown notebook stored beside the user-wide agent.

**Architecture:** Keep `threejs-expert.md` in place and use a sibling `threejs-expert/` directory as the only durable learning store. The prompt resolves the notebook relative to the agent definition, reads its concise index first, loads only relevant typed notes, and never falls back to Claude memory, SDL memory, or repository files.

**Tech Stack:** Markdown, Claude Code agent YAML, PowerShell, bundled agent validator.

---

## File structure

- Modify: `C:\Users\glitt\.claude\agents\threejs-expert.md` — remove managed memory and define the Markdown notebook protocol.
- Create: `C:\Users\glitt\.claude\agents\threejs-expert\NOTEBOOK.md` — concise topic and category index.
- Create: `C:\Users\glitt\.claude\agents\threejs-expert\notes\decisions.md` — durable design choices and outcomes.
- Create: `C:\Users\glitt\.claude\agents\threejs-expert\notes\experiments.md` — methods, measurements, and results.
- Create: `C:\Users\glitt\.claude\agents\threejs-expert\notes\patterns.md` — reusable approaches that worked.
- Create: `C:\Users\glitt\.claude\agents\threejs-expert\notes\failures.md` — failed approaches and avoidance guidance.
- Create: `C:\Users\glitt\.claude\agents\threejs-expert\notes\resources.md` — vetted resources, versions, and verification dates.
- Create: `C:\Users\glitt\.claude\agents\threejs-expert\notes\bugs.md` — reproducible Three.js/browser/GPU/SDL-MCP interoperability bugs.
- Reference: `F:\Claude\projects\sdl-mcp\sdl-mcp\docs\superpowers\specs\2026-07-11-threejs-expert-notebook-design.md`.

## Chunk 1: Replace managed memory with the notebook

### Task 1: Create typed notebook files

- [ ] **Step 1: Verify the precondition**

Run a PowerShell assertion that the current frontmatter contains `memory: user` and the sibling notebook does not yet exist. Expected: both assertions pass; stop on unexpected existing notebook content rather than overwriting it.

- [ ] **Step 2: Create the notebook index and typed files**

Create `NOTEBOOK.md` with relative links to all six typed files and `No durable notes yet.` as the initial topic state. Create each typed file with its title, purpose, and a compact commented entry shape. Do not add a database, schema file, automation hook, or duplicate index.

The common entry identity is a dated heading:

```markdown
## YYYY-MM-DD — Topic
```

Type-specific fields stay minimal. Decisions record context, decision, evidence, outcome, and status. Experiments record question, versions/environment, method, result, and conclusion. Patterns and failures record context, approach, evidence, and applicability or avoidance guidance. Resources record purpose, version scope, source, and verified date. Bugs record status, versions/environment, reproduction, expected/actual behavior, evidence, impact, workaround, suspected boundary, and sources.

- [ ] **Step 3: Verify notebook links and initial state**

Run a PowerShell check that resolves every Markdown link in `NOTEBOOK.md` beneath the notebook directory, confirms all six files are regular files, and confirms the index contains no note bodies. Expected: `PASS: notebook layout`.

### Task 2: Update the agent protocol

- [ ] **Step 1: Remove Claude-managed memory configuration**

Delete `memory: user` from frontmatter. Preserve `name`, `description`, `model`, and `color` unchanged.

- [ ] **Step 2: Replace persistence wording**

Change the core responsibility and work-process references from memory to notebook learning. Replace `## Private memory` with `## Notebook protocol` that requires:

```text
Read threejs-expert/NOTEBOOK.md first.
Load only task-relevant typed notes.
Revalidate drift-prone notes against current evidence.
Update or supersede an existing entry before appending a duplicate.
Write only durable, abstracted, evidence-backed learning after substantive work.
Keep NOTEBOOK.md concise and update it only when discoverability changes.
Do not use Claude memory, SDL memory, or repository files as fallback storage.
```

Resolve the sibling path relative to the agent definition when the harness exposes that path; otherwise use `C:\Users\glitt\.claude\agents\threejs-expert\`.

If the notebook is absent, initialize only the approved index and six typed files. If any notebook path is unreadable or unwritable, continue the primary task, report the affected path and unsaved note, and do not fall back to another persistence mechanism.

- [ ] **Step 3: Preserve privacy and bug fields**

Keep the existing exclusions for secrets, personal data, proprietary content, project identifiers, project paths, and unsupported hypotheses. Preserve the complete bug-entry evidence contract and report unsaved notes if a write fails.

- [ ] **Step 4: Remove stale persistence phrases**

Ensure the prompt no longer contains the affirmative instructions `relevant memory`, `Use SDL memory only when enabled`, `notes belong only in Claude Code user memory`, or `Use only Claude Code's user-scoped managed memory directory`. Update the output contract to report whether the durable notebook changed.

## Chunk 2: Validate and commit

### Task 3: Validate the portable contract

- [ ] **Step 1: Run focused structural assertions**

Run PowerShell assertions that frontmatter has exactly two delimiters, contains the four retained keys, omits `memory`, includes `## Notebook protocol`, names all notebook files, includes prompt-relative resolution plus the missing/unreadable/unwritable and no-fallback rules, and contains none of the stale affirmative persistence phrases. Also assert that the Three.js skill loading, current-documentation research, cage-graph, SDL-MCP, privacy, quality, and failure-handling sections remain present. Expected: `PASS: notebook agent structure`.

- [ ] **Step 2: Run the bundled agent validator**

Run:

```powershell
& 'C:\Program Files\Git\bin\bash.exe' 'C:/Users/glitt/.codex/plugins/cache/claude-plugins-official/plugin-dev/local/skills/agent-development/scripts/validate-agent.sh' 'C:/Users/glitt/.claude/agents/threejs-expert.md'
```

Expected: exit code 0. The validator's legacy `<example>` advisory remains non-blocking if emitted.

- [ ] **Step 3: Smoke-load the agent**

Run `claude --agent threejs-expert --print 'Reply with exactly: THREEJS_EXPERT_READY'` from `$env:TEMP`. Expected: exactly `THREEJS_EXPERT_READY` and exit code 0.

- [ ] **Step 4: Review the final diff and repository state**

Confirm the user-wide agent/notebook files match the approved design, `git diff --check` passes, and the repository contains only the committed design plus this plan. No runtime source or dependency changes are allowed.

- [ ] **Step 5: Commit the plan**

```powershell
git add -- docs/superpowers/plans/2026-07-11-threejs-expert-notebook.md
git diff --cached --check
git commit -m "docs: plan Three.js expert notebook protocol"
```

Expected: one documentation commit on the current branch.
