# Tool Enforcement

Use tool enforcement when you want agents to realize SDL-MCP's token savings in practice instead of drifting back to native read and shell tools.

Tool enforcement is optional, but highly recommended for coding agents. Without it, a client may still have SDL-MCP connected while wasting tokens on default tools.

---

## Recommended Command

Generate an SDL-first setup for a specific client:

```bash
sdl-mcp init --client <client> --enforce-agent-tools
```

Supported client values:

- `claude-code`
- `codex`
- `gemini`
- `opencode`

This setup enables:

- `codeMode.enabled: true`
- `codeMode.exclusive: true`
- `runtime.enabled: true`
- the recommended agent runtime set: `node`, `typescript`, `python`, `ruby`, `php`, `shell`

It also generates repo-local instruction files and client-specific enforcement assets where the client supports them.

---

## Why It Matters

SDL-MCP's token savings depend on the model actually using SDL tools:

1. `sdl.repo.status`
2. `sdl.action.search`
3. focused `sdl.manual`
4. `sdl.chain`
5. `runtimeExecute` inside `sdl.chain`

If an agent falls back to native file reads or native shell commands for indexed code and repo-local execution, you lose much of the token-efficiency benefit.

---

## Client Matrix

| Client | Generated docs | Generated hard enforcement | Notes |
|:-------|:---------------|:---------------------------|:------|
| Claude Code / Claude | `AGENTS.md`, `CLAUDE.md` | `.claude/settings.json`, read hook, runtime hook, `explore-sdl` subagent, prompt file | Strongest current hook-based enforcement |
| Codex App / Codex CLI | `AGENTS.md`, `CODEX.md` | No native hook assets generated | Instruction-driven enforcement via repo-local docs |
| Gemini CLI | `AGENTS.md`, `GEMINI.md` | No native hook assets generated | Instruction-driven enforcement via repo-local docs |
| OpenCode CLI | `AGENTS.md`, `OPENCODE.md` | `opencode.json`, `.opencode/plugins/enforce-sdl.ts` | Uses project config plus plugin enforcement |

---

## Per-Client Notes

### Claude Code / Claude

Claude gets the most complete enforcement path:

- native `Read` is redirected to SDL for indexed source code
- common native Bash test/build/lint commands are redirected to SDL runtime
- the built-in `Explore` agent is replaced with `explore-sdl`

See the client-specific guide in [tool-enforcement-for-claude.md](./tool-enforcement-for-claude.md).

### Codex App / Codex CLI

Codex currently relies on repo-local instruction files rather than generated hook assets. The generated `CODEX.md` and `AGENTS.md` direct the agent toward SDL-first workflows and away from token-heavy native reads and shell commands.

### Gemini CLI

Gemini currently uses the same repo-local instruction strategy as Codex in SDL-MCP's generated setup. The goal is the same: keep code understanding and repo-local execution inside SDL-MCP whenever possible.

### OpenCode CLI

OpenCode gets both instruction files and generated project-local enforcement assets:

- `opencode.json`
- `.opencode/plugins/enforce-sdl.ts`

This allows SDL-MCP to steer both discovery and execution more aggressively than instruction-only setups.

---

## Recommended Next Step

After generating the enforcement setup:

1. connect the client to SDL-MCP
2. start the session with `sdl.repo.status`
3. confirm the agent is using `sdl.action.search`, `sdl.manual`, and `sdl.chain`
4. confirm repo-local execution is happening through SDL runtime rather than the client's native shell tool
