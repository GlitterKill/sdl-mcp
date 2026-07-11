# Three.js Expert Agent Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create and validate a user-wide Claude Code `threejs-expert` agent for cage-graph work, current Three.js research, private cross-project learning, and SDL-MCP interoperability tracking.

**Architecture:** Use one user-scoped agent Markdown file with native `memory: user`; do not add a plugin, dependency, hook, or note service. The prompt dynamically reads trusted `threejs-*` skill files from the canonical external skills directory so disabled skills remain available, and it keeps all durable notes inside Claude Code's managed agent-memory directory.

**Tech Stack:** Claude Code custom subagent Markdown/YAML, PowerShell, Git Bash validator, Context7, Three.js official documentation, SDL-MCP.

---

## File structure

- Create: `C:\Users\glitt\.claude\agents\threejs-expert.md` — the complete global agent definition, trigger contract, work process, skill-loading policy, research policy, private-memory policy, and SDL-MCP interoperability workflow.
- Do not create repository implementation files. The agent's private notes are created lazily by Claude Code under `C:\Users\glitt\.claude\agent-memory\threejs-expert\`.
- Reference: `F:\Claude\projects\sdl-mcp\sdl-mcp\docs\superpowers\specs\2026-07-10-threejs-expert-agent-design.md`.
- Validate with: `C:\Users\glitt\.codex\plugins\cache\claude-plugins-official\plugin-dev\local\skills\agent-development\scripts\validate-agent.sh`.

## Chunk 1: Create and validate the global agent

### Task 1: User-wide Three.js expert agent

**Files:**
- Create: `C:\Users\glitt\.claude\agents\threejs-expert.md`
- Test: inline PowerShell structural assertions and the bundled Bash agent validator

- [ ] **Step 1: Check the target and trusted skill inventory**

Run:

```powershell
$agentPath = 'C:\Users\glitt\.claude\agents\threejs-expert.md'
$skillsRoot = 'C:\Users\glitt\.agents\skills'
$baselinePath = Join-Path $env:TEMP 'threejs-expert-agent-git-before.txt'
$repo = 'F:\Claude\projects\sdl-mcp\sdl-mcp'

$gitBefore = (& git -C $repo status --porcelain=v1 | Out-String)
if ($LASTEXITCODE -ne 0) { throw "Failed to capture repository baseline (git exit $LASTEXITCODE)" }
Set-Content -LiteralPath $baselinePath -Value $gitBefore -NoNewline
Write-Output "BASELINE: $baselinePath"

if (Test-Path -LiteralPath $agentPath) {
  Write-Output "EXISTS: $agentPath"
  Get-Content -Raw -LiteralPath $agentPath
} else {
  Write-Output "MISSING: $agentPath"
}

Get-ChildItem -LiteralPath $skillsRoot -Directory -Filter 'threejs-*' |
  Sort-Object Name |
  Select-Object Name, FullName, LinkType, Attributes
```

Expected:

- The Git baseline path is reported. Keep it until Step 9.
- The target is reported as `MISSING`. If it exists and differs from the approved design, stop and report the conflict instead of overwriting it. If it already matches the approved design, skip Steps 3-4 and continue at Step 5.
- The inventory includes `threejs-animation`, `threejs-fundamentals`, `threejs-geometry`, `threejs-interaction`, `threejs-lighting`, `threejs-loaders`, `threejs-materials`, `threejs-postprocessing`, `threejs-shaders`, and `threejs-textures`.

- [ ] **Step 2: Run the structural check and verify the pre-implementation failure**

Run:

```powershell
$path = 'C:\Users\glitt\.claude\agents\threejs-expert.md'
if (-not (Test-Path -LiteralPath $path)) {
  throw "Agent file missing: $path"
}
```

Expected: FAIL with `Agent file missing`. If Step 1 found an existing compliant agent, record that the implementation already exists, skip Steps 3-4, and proceed directly to Step 5 without rewriting it.

- [ ] **Step 3: Create the agent directory only when the target is missing**

Run:

```powershell
New-Item -ItemType Directory -Force 'C:\Users\glitt\.claude\agents' | Out-Null
```

Expected: exit code 0.

- [ ] **Step 4: Create the minimal agent definition only when the target is missing**

Create `C:\Users\glitt\.claude\agents\threejs-expert.md` with `apply_patch` using this exact content:

```markdown
---
name: threejs-expert
description: Use this agent when Three.js expertise is needed for cage graphs or related 3D visualization work. Typical triggers include designing or implementing a Three.js cage graph, diagnosing rendering or GPU-performance problems, researching current Three.js APIs and resources, and investigating Three.js bugs that may affect SDL-MCP workflows. Do not invoke it for unrelated generic frontend work or SDL-MCP work with no Three.js boundary. See "When to invoke" in the agent body for worked scenarios.
model: inherit
color: cyan
memory: user
---

You are a Three.js expert in correct, efficient, interactive cage graphs.

## When to invoke

- **Cage-graph design or implementation:** scene architecture, geometry, nodes, edges, labels, picking, cameras, animation, or interaction.
- **Three.js diagnosis or optimization:** visual defects, leaks, slow frames, draw calls, shaders, GPU differences, or disposal.
- **Current Three.js research:** APIs, releases, tools, assets, or techniques needing primary-source verification.
- **SDL-MCP interoperability:** a Three.js boundary may expose an SDL-MCP indexing, retrieval, editing, runtime, or graph-workflow bug.

Exclude unrelated generic frontend or non-Three.js visualization work, and general SDL-MCP work with no Three.js boundary.

## Core responsibilities

Build, debug, and review cage graphs; measure rendering and resource-lifetime changes; align API facts to the target release; load relevant local skills, including disabled skills; diagnose before editing; and keep reusable, privacy-safe memory.

## Load the local Three.js skills

The canonical skills root is C:\Users\glitt\.agents\skills.

1. Resolve its real path. Discover real, non-reparse directories directly beneath it named threejs-*; reject candidates escaping the real root.
2. Select task-relevant and user-named skills. Resolve each selected skill directory. Accept SKILL.md only if it resolves to a readable regular non-reparse-point file inside that same real selected skill directory. Reject missing, directory, symlink, junction, reparse, or escaping paths.
3. Read accepted SKILL.md files completely before task actions. Direct filesystem access preserves dynamic access when disabled skills cannot be invoked.
4. Follow only routed references. Every local reference must resolve to a readable regular non-reparse-point file inside that same real selected skill directory; reject reparse or escaping references.
5. Report rejected, missing, or unreadable files; never claim they loaded.

Expected domains include animation, fundamentals, geometry, interaction, lighting, loaders, materials, post-processing, shaders, and textures. Discover future threejs-* skills dynamically.

## Stay current

- Project and selected-skill instructions govern workflow. Inspect package metadata and lockfiles for Three.js and its stack.
- Without project/lock release metadata, ask for the target release. Only when safe, assume the current stable official release and state it.
- Use Context7 first: resolve Three.js, then query a matching versioned library ID.
- Official installed/target-version docs, examples, changelog, migration guidance, and source tags govern Three.js API facts. If Context7 lacks that release, state the fallback, use official sources, and avoid later APIs.
- Use https://github.com/AxiomeCG/awesome-threejs#resources only for discovery; validate consequential third-party guidance against primary sources.

## Cage-graph standards

- Reuse the renderer, graph model, project patterns, browser features, and Three.js before adding dependencies or abstractions.
- Keep graph data, layout state, scene objects, rendering, interaction, and cleanup as explicit ownership boundaries.
- Add instancing, batching, level of detail, spatial indexing, or GPU picking only when scale and profiling justify them.
- Treat readable labels, keyboard controls, reduced motion, contrast, and non-WebGL fallback messaging as baseline accessibility.
- The owner stops animation loops and disposes geometries, materials, textures, render targets, controls, observers, listeners, and GPU/browser resources.
- Measure before optimizing; report baseline/result, scene size, workload, device/GPU, browser, method, and delta.

## Work process

1. Read project instructions and relevant memory; identify the Three.js, cage-graph, browser, GPU, or SDL-MCP boundary.
2. Load relevant skills; inspect implementation, callers, ownership, and lifecycle paths.
3. Verify versioned APIs when drift matters. State assumptions; separate evidence from hypotheses.
4. Reproduce and diagnose the smallest failing boundary before editing. Implement only when requested.
5. Choose the smallest solution without weakening validation, security, accessibility, cleanup, or data safety.
6. Verify with the smallest relevant check; require browser/runtime evidence for visual and performance claims.
7. Save only durable, abstracted, evidence-backed learning allowed below.

## SDL-MCP workflow

In SDL-enabled repositories, start with repository status. Use task-shaped context, symbol cards, graph slices, skeletons, and hot paths before gated windows. Never use native raw reads for indexed source; run commands through bounded SDL runtime with persisted output.

Use SDL memory only when enabled. Never use repository files as this agent's notebook; notes belong only in Claude Code user memory.

For interoperability bugs, reproduce the smallest boundary; separate confirmed Three.js/application behavior from confirmed SDL-MCP behavior; capture sanitized versions, inputs, outputs, environment, and evidence. Do not file issues, change SDL-MCP, edit repository docs, or broaden external state without explicit authorization.

## Private memory

Use only Claude Code's user-scoped managed memory directory, never repository files. Keep MEMORY.md concise. Lazily use decisions.md for choices/outcomes, experiments.md for methods/results/failures, resources.md for links/purpose/version/retrieval date, and bugs.md for reproducible Three.js, browser, GPU, or SDL-MCP bugs.

Abstract notes into reusable guidance. Unless explicitly authorized, never persist proprietary source/payloads, project/repository identifiers, machine-specific absolute paths, or project-specific evidence. Never store secrets, credentials, personal data, or hypotheses as facts. Revalidate project-specific findings before reuse elsewhere. Supersede rather than duplicate.

Every bug entry includes status; symptom; relevant versions and environment; minimal reproduction; expected behavior; actual behavior; evidence; impact; workaround; suspected boundary; and source links. Label hypotheses. If a write fails, report the unsaved note; never put it in the project.

## Quality standards

- Match project conventions and target release; prefer reuse, platform features, and small changes.
- Distinguish observed evidence, inference, hypothesis, and recommendation.
- Claim visual correctness or performance improvement only with a relevant check.
- Comment only non-obvious flow, ownership, cleanup, and performance ceilings.
- Update product/API docs only for authorized edits changing behavior.

## Output format

Lead with outcome, relevant versions, verification evidence, and direct sources. Separate facts from hypotheses.

For bugs report reproduction; boundary/evidence; impact; workaround; and next action. Say whether durable memory changed without exposing unrelated notes.

## Failure handling

- Unsafe/missing skill or reference: identify it, continue with accepted skills, and do not claim full coverage.
- Documentation unavailable: state the gap and mark version-sensitive conclusions potentially stale.
- Conflicts: project/selected-skill instructions control workflow; official installed/target-version sources control API facts.
- Resource unavailable: find a primary replacement when practical.
- Unclear ownership, destructive scope, or external-state impact: stop and ask before acting.
```

Expected: one new Markdown file; no plugin scaffolding, copied skills, hook, note database, or repository source change.

- [ ] **Step 5: Run the deterministic PowerShell structural check**

Run:

```powershell
$path = 'C:\Users\glitt\.claude\agents\threejs-expert.md'
$content = Get-Content -Raw -LiteralPath $path
$parts = [regex]::Split($content, '(?m)^---\s*$')

if ($parts.Count -ne 3) { throw "Expected exactly two frontmatter delimiters" }

$frontmatter = $parts[1]
$prompt = $parts[2]

$requiredFrontmatter = @(
  '(?m)^name:\s+threejs-expert\s*$',
  '(?m)^description:\s+Use this agent when.+See "When to invoke" in the agent body for worked scenarios\.\s*$',
  '(?m)^model:\s+inherit\s*$',
  '(?m)^color:\s+cyan\s*$',
  '(?m)^memory:\s+user\s*$'
)

foreach ($pattern in $requiredFrontmatter) {
  if ($frontmatter -notmatch $pattern) { throw "Missing frontmatter pattern: $pattern" }
}

$requiredDescriptionTerms = @(
  'designing or implementing a Three.js cage graph',
  'diagnosing rendering or GPU-performance problems',
  'researching current Three.js APIs and resources',
  'investigating Three.js bugs that may affect SDL-MCP workflows',
  'unrelated generic frontend work',
  'SDL-MCP work with no Three.js boundary'
)

foreach ($term in $requiredDescriptionTerms) {
  if ($frontmatter.IndexOf($term, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
    throw "Missing description term: $term"
  }
}

$promptLength = $prompt.Trim().Length
if ($promptLength -lt 20 -or $promptLength -gt 7500) {
  throw "Prompt length out of range: $promptLength"
}

$requiredSections = @(
  '## When to invoke',
  '## Core responsibilities',
  '## Load the local Three.js skills',
  '## Stay current',
  '## Cage-graph standards',
  '## Work process',
  '## SDL-MCP workflow',
  '## Private memory',
  '## Quality standards',
  '## Output format',
  '## Failure handling'
)

foreach ($section in $requiredSections) {
  if (-not $content.Contains($section)) { throw "Missing section: $section" }
}

$placeholderPattern = '(?im)\b(' + 'TO' + 'DO|T' + 'BD)\b'
if ($content -match $placeholderPattern) { throw 'Placeholder found' }

Write-Output "PASS: threejs-expert structure ($promptLength prompt characters)"
```

Expected: `PASS: threejs-expert structure (... prompt characters)` with a prompt length from 20 through 7,500 characters. The description assertions deterministically cover all four positive trigger domains and both exclusions.

- [ ] **Step 6: Run the bundled agent validator**

Run:

```powershell
$bash = 'C:\Program Files\Git\bin\bash.exe'
$validator = 'C:/Users/glitt/.codex/plugins/cache/claude-plugins-official/plugin-dev/local/skills/agent-development/scripts/validate-agent.sh'
$agent = 'C:/Users/glitt/.claude/agents/threejs-expert.md'

if (-not (Test-Path -LiteralPath $bash)) { throw "Git Bash missing: $bash" }
if (-not (Test-Path -LiteralPath ($validator -replace '/', '\'))) { throw "Validator missing: $validator" }

& $bash $validator $agent
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
```

Expected: exit code 0. The validator may emit its legacy advisory requesting `<example>` blocks; this is non-blocking because the current agent-development skill requires flat prose trigger scenarios.

- [ ] **Step 7: Verify trusted dynamic skill discovery**

Run:

```powershell
$root = [IO.Path]::GetFullPath('C:\Users\glitt\.agents\skills').TrimEnd('\') + '\'
$expected = @(
  'threejs-animation',
  'threejs-fundamentals',
  'threejs-geometry',
  'threejs-interaction',
  'threejs-lighting',
  'threejs-loaders',
  'threejs-materials',
  'threejs-postprocessing',
  'threejs-shaders',
  'threejs-textures'
)

$trusted = Get-ChildItem -LiteralPath $root -Directory -Filter 'threejs-*' |
  Where-Object {
    $full = [IO.Path]::GetFullPath($_.FullName)
    $insideRoot = $full.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)
    $isReparsePoint = ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
    $insideRoot -and -not $isReparsePoint -and (Test-Path -LiteralPath (Join-Path $full 'SKILL.md'))
  } |
  Select-Object -ExpandProperty Name

$missing = $expected | Where-Object { $_ -notin $trusted }
if ($missing) { throw "Missing trusted skills: $($missing -join ', ')" }

Write-Output "PASS: trusted Three.js skills ($($trusted.Count)): $($trusted -join ', ')"
```

Expected: PASS and all ten expected skill names.

- [ ] **Step 8: Prove Claude Code loads the YAML agent definition**

Run in a fresh Claude Code process:

```powershell
Push-Location $env:TEMP
try {
  $result = & claude --agent threejs-expert --max-turns 1 --print 'Reply with exactly: THREEJS_EXPERT_READY'
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
  Pop-Location
}
if (($result | Out-String).Trim() -ne 'THREEJS_EXPERT_READY') {
  throw "Unexpected agent smoke output: $result"
}
Write-Output 'PASS: Claude Code loaded threejs-expert'
```

Expected: `PASS: Claude Code loaded threejs-expert`. Running from the neutral temporary directory prevents a project-level `.claude/agents` definition from shadowing the user-wide file. This forced `--agent` invocation is the authoritative YAML/frontmatter parse and registration check; it proves registration, while automatic routing remains classifier-driven by the description and prompt. A malformed definition must fail this step.

- [ ] **Step 9: Verify repository isolation against the captured baseline**

Run:

```powershell
$baselinePath = Join-Path $env:TEMP 'threejs-expert-agent-git-before.txt'
$repo = 'F:\Claude\projects\sdl-mcp\sdl-mcp'
if (-not (Test-Path -LiteralPath $baselinePath)) { throw "Missing Git baseline: $baselinePath" }

$before = Get-Content -Raw -LiteralPath $baselinePath
$after = (& git -C $repo status --porcelain=v1 | Out-String)
if ($LASTEXITCODE -ne 0) { throw "Failed to read repository state (git exit $LASTEXITCODE)" }
if ($before -ne $after) {
  throw "Repository state changed during global-agent implementation.
BEFORE:
$before
AFTER:
$after"
}

Remove-Item -LiteralPath $baselinePath
Write-Output 'PASS: repository state unchanged'
```

Expected: `PASS: repository state unchanged`. The global agent is intentionally outside Git, so do not create a repository commit solely to manufacture an implementation commit.

- [ ] **Step 10: Report activation behavior**

Report that Claude Code watches an existing `~/.claude/agents/` directory and normally loads edits within a few seconds. Restart only if this was the first agent file in a newly created `agents` directory or the session used `--disable-slash-commands`.

Include:

- Global agent path.
- Structural-check result.
- Bundled-validator result.
- Trusted-skill inventory result.
- Confirmation that notes use Claude Code's private user-memory scope.
- Confirmation that no repository implementation files changed.
