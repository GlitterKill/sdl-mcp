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
4. `sdl.context` for direct code context retrieval (`contextMode: "precise"` or `"broad"`)
5. `sdl.context` first for Code Mode explain/debug/review/implement requests
6. `sdl.workflow` for batched follow-ups, runtime execution, data transforms, and batch mutations
7. `runtimeExecute` inside `sdl.workflow` for repo-local commands

The generated enforcement files also teach:

- use `symbolRef` / `symbolRefs` when the agent knows a symbol name but not the canonical `symbolId`
- follow structured recovery guidance such as `nextBestAction`, `fallbackTools`, `fallbackRationale`, and candidate lists instead of retrying blocked native tools
- use `file.read` and `file.write` inside SDL-MCP for non-indexed files with targeted modes
- use `symbol.edit` or the symbol edit preview/apply path for indexed source writes

If an agent falls back to native repo file tools or native shell commands while SDL-MCP is active, you lose much of the token-efficiency benefit and bypass the graph-aware policy.

---

## Client Matrix

| Client                | Generated docs             | Generated hard enforcement                                                            | Notes                                              |
| :-------------------- | :------------------------- | :------------------------------------------------------------------------------------ | :------------------------------------------------- |
| Claude Code / Claude  | `AGENTS.md`, `CLAUDE.md`   | `.claude/settings.json`, file hook, runtime hook, `explore-sdl` subagent, prompt file | Strongest current hook-based enforcement           |
| Codex App / Codex CLI | `AGENTS.md`, `CODEX.md`    | `.codex/config.toml`, `.codex/hooks.json`, `.codex/hooks/load-sdl-skill.mjs`, `.codex/hooks/force-sdl-mcp.mjs` | Uses Codex lifecycle hooks plus repo-local docs    |
| Gemini CLI            | `AGENTS.md`, `GEMINI.md`   | No native hook assets generated                                                       | Instruction-driven enforcement via repo-local docs |
| OpenCode CLI          | `AGENTS.md`, `OPENCODE.md` | `opencode.json`, `.opencode/plugins/enforce-sdl.ts`                                   | Uses project config plus plugin enforcement        |

---

## Per-Client Notes

### Claude Code / Claude

Claude gets the most complete enforcement path:

- repo-local native file reads, writes, edits, and patches are redirected to SDL-MCP when the PID file is present
- repo-local native Bash commands are redirected to SDL runtime
- the built-in `Explore` agent is replaced with `explore-sdl`

See the client-specific guide in [tool-enforcement-for-claude.md](./tool-enforcement-for-claude.md).

### Codex App / Codex CLI

Codex gets repo-local instruction files and Codex lifecycle hook assets. The generated `.codex/config.toml` enables `codex_hooks`, `.codex/hooks.json` registers a `SessionStart` skill-loader hook plus a broad `PreToolUse` policy hook, `.codex/hooks/load-sdl-skill.mjs` injects the lean `sdl-mcp-agent-workflow` skill body at session start, and `.codex/hooks/force-sdl-mcp.mjs` redirects repo-local native shell, file read/write/edit, apply-patch, and non-SDL MCP file/search tools toward SDL-MCP when the PID file is present. Native access remains allowed for `.codex/**`, `.claude/**`, and non-repo skills, memories, and session internals.

The generated `CODEX.md` and `AGENTS.md` still matter: they describe natural-identifier lookup and fallback-guided recovery so Codex can stay inside SDL-MCP even when the exact `symbolId` is unknown.

### Gemini CLI

Gemini currently uses the same repo-local instruction strategy as Codex in SDL-MCP's generated setup. The goal is the same: keep code understanding and repo-local execution inside SDL-MCP whenever possible.

### OpenCode CLI

OpenCode gets both instruction files and generated project-local enforcement assets:

- `opencode.json`
- `.opencode/plugins/enforce-sdl.ts`

This allows SDL-MCP to steer both discovery and execution more aggressively than instruction-only setups.

The generated instruction layer still matters because it tells the model how to use the newer SDL patterns after a plugin or permission rule blocks a native tool.

---

## Recommended Next Step

After generating the enforcement setup:

1. connect the client to SDL-MCP
2. start the session with `sdl.repo.status`
3. confirm the agent uses `sdl.context` or `sdl.context` for code context retrieval
4. confirm explain/debug/review requests route to context first
5. confirm `sdl.workflow` is used for runtime execution and multi-step operations, not context retrieval
6. confirm symbol lookups can use `symbolRef` / `symbolRefs` when IDs are not yet known
7. confirm repo-local execution is happening through SDL runtime rather than the client's native shell tool
8. confirm denied or ambiguous responses are followed via `nextBestAction`, `fallbackTools`, or `fallbackRationale` instead of retrying native tools
