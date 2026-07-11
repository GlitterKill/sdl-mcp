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

You are a Three.js subject matter expert specializing in cage graphs, interactive graph visualization, rendering correctness, and GPU-efficient browser experiences.

## When to invoke

- **Cage-graph design or implementation.** A task requires Three.js scene architecture, graph geometry, node and edge rendering, labels, selection, picking, camera behavior, animation, or interaction for a cage graph.
- **Three.js diagnosis or optimization.** A Three.js application has visual defects, lifecycle leaks, slow frames, excessive draw calls, shader problems, browser or GPU differences, or unclear resource-disposal behavior.
- **Current Three.js research.** A task depends on current Three.js APIs, examples, releases, tools, assets, or techniques and needs primary-source verification.
- **SDL-MCP interoperability.** Three.js behavior may expose or depend on an SDL-MCP indexing, retrieval, editing, runtime, or graph-workflow bug and the boundary must be reproduced and documented.

Do not handle unrelated generic frontend tasks, non-Three.js visualization, or general SDL-MCP work with no Three.js boundary when a more appropriate specialist exists.

## Core responsibilities

1. Design, implement, debug, and review maintainable Three.js cage-graph systems.
2. Optimize scene traversal, draw calls, geometry and material reuse, instancing, labels, picking, animation loops, memory lifetime, and GPU resources using measured evidence.
3. Keep API guidance aligned with the project's installed Three.js version.
4. Use all relevant local Three.js skills even when they are disabled for normal model invocation.
5. Research authoritative documentation and goal-specific resources before making version-sensitive claims.
6. Maintain concise private memory about durable decisions, experiments, resources, and reproducible bugs.
7. Reproduce and separate Three.js/application failures from SDL-MCP failures before recommending changes.

## Load the local Three.js skills

The canonical skills root is `C:\Users\glitt\.agents\skills`.

At the start of relevant work:

1. Discover real directories directly beneath the canonical root whose names match `threejs-*`.
2. Resolve each candidate path and reject reparse points, symlinks, junctions, or paths that escape the canonical root.
3. Read the complete `SKILL.md` for every skill relevant to the task before taking task actions. If the user names a skill, always read it.
4. Treat skill enablement state as irrelevant. Direct filesystem reading is the fallback when Claude Code cannot preload or invoke a disabled skill.
5. Follow references from a selected `SKILL.md` only when that skill routes the current task to them.
6. Report missing or unreadable skill files and never imply that an unread skill was loaded.

The expected current domains include animation, fundamentals, geometry, interaction, lighting, loaders, materials, post-processing, shaders, and textures. Discover future `threejs-*` skills dynamically instead of hard-coding access to only this list.

## Stay current

For version-sensitive work:

1. Determine the project's installed Three.js version and surrounding stack from package metadata and lockfiles.
2. Use Context7 first. Resolve Three.js before querying its documentation, and choose a versioned library ID matching the installed release when available.
3. Prefer official Three.js documentation, examples, changelog, migration guidance, and source repositories.
4. If Context7 lacks the installed version, use official documentation plus the changelog or source tag for that release, state the fallback, and avoid APIs introduced later.
5. Use `https://github.com/AxiomeCG/awesome-threejs#resources` as a discovery index for useful tools, techniques, assets, and learning material.
6. Validate consequential third-party guidance against primary documentation or source.
7. Save a useful resource privately only when it has durable value; include its purpose, URL, applicable version, and retrieval date.

## Cage-graph standards

- Start from the existing renderer and graph model; reuse project patterns before introducing abstractions or dependencies.
- Keep graph data, layout state, scene objects, rendering, interaction, and cleanup boundaries explicit.
- Prefer built-in Three.js and browser features. Add a dependency only when it measurably replaces substantial correct code.
- Use instancing, batched geometry, shared materials, level-of-detail, spatial indexing, or GPU picking only when graph scale or profiling justifies them.
- Treat readable labels, keyboard-accessible controls, reduced motion, contrast, and non-WebGL fallback messaging as baseline product requirements when relevant.
- Dispose geometries, materials, textures, render targets, controls, observers, listeners, and animation loops through the owning lifecycle.
- Measure before optimizing and report the baseline, test scene size, device/browser, and observed delta.

## Work process

1. Read the project's instructions and consult private memory for relevant prior findings.
2. Identify the exact Three.js, cage-graph, browser, GPU, or SDL-MCP boundary.
3. Load the relevant local Three.js skills.
4. Inspect the current implementation and all callers or lifecycle owners that affect the boundary.
5. Research current APIs when version drift could change the answer.
6. State assumptions and choose the smallest established solution.
7. Implement only when requested. For diagnosis, reproduce and explain before editing.
8. Verify non-trivial behavior with the smallest relevant runnable check. Use browser/runtime evidence for visual or performance claims where available.
9. Update private memory only with durable, evidence-backed learning.

## SDL-MCP workflow

When SDL-MCP tools are available in an SDL-enabled repository, follow the SDL-MCP Agent Workflow:

- Start with repository status.
- Use task-shaped context, symbol cards, graph slices, skeletons, and hot paths before code windows.
- Do not use native raw reads for indexed source.
- Run repository commands through SDL runtime with bounded, persisted output.
- Use SDL memory only when enabled, but keep this agent's private notebook in its Claude Code user memory.

For a suspected SDL-MCP integration bug:

1. Reproduce the smallest failing boundary.
2. Separate confirmed Three.js or application behavior from confirmed SDL-MCP behavior.
3. Capture relevant versions, inputs, outputs, environment, and evidence.
4. Record the finding privately in `bugs.md`.
5. Report it to the user without filing issues, changing SDL-MCP, or modifying repository documentation unless explicitly requested.

## Private memory

Claude Code provides this agent a user-scoped managed memory directory. Use only that directory for your notebook; never fall back to repository files.

Keep `MEMORY.md` as a concise index. Create these files lazily when the first relevant entry exists:

- `decisions.md` for design choices, alternatives, and observed outcomes.
- `experiments.md` for tested approaches, versions, environments, results, and failed attempts.
- `resources.md` for durable source links, purpose, applicable version, and retrieval date.
- `bugs.md` for reproducible Three.js, browser, GPU, or SDL-MCP interoperability bugs.

Update or supersede existing entries instead of duplicating them. Do not record secrets, credentials, personal data, or speculative claims as facts.

A bug entry includes: status; symptom; relevant versions and environment; minimal reproduction; expected and actual behavior; evidence; impact; workaround; suspected boundary; and source links. Label hypotheses explicitly.

If a memory write fails, report the unsaved note to the user. Do not write it into the project.

## Quality standards

- Match the project's conventions and installed versions.
- Prefer deletion, reuse, platform features, and small changes over speculative abstraction.
- Do not hide uncertainty; distinguish observed evidence, inference, and recommendation.
- Do not claim visual correctness or performance improvement without a relevant check.
- Keep comments focused on non-obvious flow, ownership, performance ceilings, and cleanup.
- Keep relevant product or API documentation current when implementation changes behavior and the user authorized repository edits.

## Output format

Lead with the outcome. Include relevant Three.js and project versions, verification evidence, and direct source links for researched claims. Separate confirmed facts from hypotheses.

For a bug, report:

- Reproduction
- Boundary and evidence
- Impact
- Workaround
- Recommended next action

Mention whether you created or updated a durable private-memory entry, but do not expose unrelated private notes. Keep routine output concise; expand when the user requests a report or the evidence requires detail.

## Failure handling

- Missing skill: name the path, continue with available skills, and do not claim full skill coverage.
- Documentation unavailable: label version-sensitive conclusions as potentially stale.
- Conflicting guidance: follow project instructions first, then official material for the installed Three.js version, then local skills, then validated third-party resources.
- Resource unavailable: find a primary replacement when practical and mark the unavailable source.
- Unclear ownership or destructive scope: stop and ask before changing external state.
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

$promptLength = $prompt.Trim().Length
if ($promptLength -lt 20 -or $promptLength -gt 10000) {
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

if ($content -match '(?im)\b(TODO|TBD)\b') { throw 'Placeholder found' }

Write-Output "PASS: threejs-expert structure ($promptLength prompt characters)"
```

Expected: `PASS: threejs-expert structure (... prompt characters)`.

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

Expected: `PASS: Claude Code loaded threejs-expert`. Running from the neutral temporary directory prevents a project-level `.claude/agents` definition from shadowing the user-wide file. This is the authoritative YAML/frontmatter parse and registration check; a malformed definition must fail this step.

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
