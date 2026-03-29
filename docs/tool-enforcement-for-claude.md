# Enforcing SDL-MCP Tool Use with Claude Code and Claude

This guide describes the current SDL-first enforcement path for Claude clients.

For the cross-client overview covering Claude, Codex, Gemini, and OpenCode, see [tool-enforcement.md](./tool-enforcement.md).

The recommended setup is no longer a manual collection of ad hoc files. Use the generated enforcement profile:

```bash
sdl-mcp init --client claude-code --enforce-agent-tools
```

That setup enables SDL runtime and code mode in config, writes repo-local instruction files, and generates Claude-specific hook assets.

---

## What Gets Generated

When you run the enforced init flow for Claude, SDL-MCP creates:

- `AGENTS.md`
- `CLAUDE.md`
- `.claude/settings.json`
- `.claude/hooks/force-sdl-mcp.sh`
- `.claude/hooks/force-sdl-runtime.sh`
- `.claude/agents/explore-sdl.md`
- `.claude/sdl-prompt.md`

The generated files steer Claude toward:

1. `sdl.repo.status`
2. `sdl.action.search`
3. focused `sdl.manual`
4. `sdl.agent.context` for direct code context retrieval (`contextMode: "precise"` or `"broad"`)
5. `sdl.context` first for Code Mode explain/debug/review/implement requests
6. `sdl.workflow` for multi-step operations (runtime execution, data transforms, batch mutations)
7. `runtimeExecute` inside `sdl.workflow` for repo-local commands

They also teach Claude to use `symbolRef` / `symbolRefs` when it knows a symbol name but not the canonical ID, and to follow SDL fallback guidance instead of retrying blocked native tools. Enforcement is conditional on the SDL-MCP server being active.

---

## Enforcement Layers

### Source-code read enforcement

`.claude/hooks/force-sdl-mcp.sh` denies native `Read` on indexed source-code extensions and redirects the model to SDL tools.

### Runtime enforcement

`.claude/hooks/force-sdl-runtime.sh` denies common native Bash test, build, lint, and diagnostic commands so the model uses SDL runtime instead.

### Permissions

`.claude/settings.json` adds deny rules for indexed source-code reads and disables the built-in `Explore` agent in favor of the generated `explore-sdl` subagent.

### Instruction layer

`CLAUDE.md`, `AGENTS.md`, and `.claude/sdl-prompt.md` reinforce the same SDL-first behavior in plain language.

That instruction layer now includes natural-identifier lookup and guidance fields such as `fallbackTools` and `fallbackRationale`.

---

## Indexed Source Extensions

| Language | Extensions |
|----------|-----------|
| TypeScript/JavaScript | `.ts` `.tsx` `.js` `.jsx` `.mjs` `.cjs` |
| Python | `.py` `.pyw` |
| Go | `.go` |
| Java | `.java` |
| C# | `.cs` |
| C/C++ | `.c` `.h` `.cpp` `.hpp` `.cc` `.cxx` `.hxx` |
| PHP | `.php` `.phtml` |
| Rust | `.rs` |
| Kotlin | `.kt` `.kts` |
| Shell | `.sh` `.bash` `.zsh` |

Non-indexed files such as Markdown, JSON, YAML, TOML, and similar config or documentation files can still be read natively.

---

## Recommended Claude Workflow

For code understanding:

1. `sdl.repo.status`
2. `sdl.action.search` (when the correct SDL action is unclear)
3. `sdl.manual(query|actions|format)` for focused reference
4. `sdl.agent.context` with `contextMode: "precise"` for targeted lookups or `"broad"` for exploration
5. `sdl.context` when Claude is already operating inside Code Mode and needs task-shaped context
5. Provide `focusSymbols` and/or `focusPaths` to scope retrieval; always set a budget

For symbol lookup:

- use `symbolRef` or `symbolRefs` when the symbol name is known but the exact `symbolId` is not
- if SDL returns ranked candidates or fallback guidance, refine the SDL request instead of retrying native `Read`

For multi-step operations:

- use `sdl.workflow` for runtime execution, data transforms, and batch mutations
- use `runtimeExecute` inside `sdl.workflow` with `outputMode: "minimal"` for repo-local commands
- supported runtimes: `node`, `typescript`, `python`, `shell`, `ruby`, `php`, `perl`, `r`, `elixir`, `go`, `java`, `kotlin`, `rust`, `c`, `cpp`, `csharp`

Do not retry denied native `Read` or `Bash` calls. Switch to SDL-MCP immediately and follow the SDL response guidance fields when present.

---

## Notes

- The generated enforcement assets are conservative. They are created automatically for new setups and do not blindly merge into existing user-managed files.
- Claude is the client with the strongest current hook support. Other client integrations rely more heavily on SDL config plus repo-local instruction files.
