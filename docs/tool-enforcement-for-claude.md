# Enforcing SDL-MCP Tool Use with Claude and Claude Code CLI

SDL-MCP indexes your entire codebase including dependencies, providing significantly better token and context efficiency compared to the native `Read` tool built into Claude Code. This guide walks through four layered enforcement mechanisms to force Claude to use SDL-MCP for supported source code files while leaving all other file types unrestricted.

## Supported Languages

SDL-MCP currently indexes the following languages:

| Language | File Extensions |
|----------|----------------|
| TypeScript | `.ts`, `.tsx` |
| JavaScript | `.js`, `.jsx`, `.mjs`, `.cjs` |
| Python | `.py`, `.pyw` |
| Go | `.go` |
| Java | `.java` |
| C# | `.cs` |
| C | `.c`, `.h` |
| C++ | `.cpp`, `.hpp`, `.cc`, `.cxx`, `.hxx` |
| PHP | `.php`, `.phtml` |
| Rust | `.rs` |
| Kotlin | `.kt`, `.kts` |
| Shell | `.sh`, `.bash`, `.zsh` |

All other file types (`.md`, `.json`, `.yaml`, `.toml`, `.xml`, `.sql`, `.css`, `.html`, `.txt`, config files, etc.) remain fully accessible through the native `Read` tool.

---

# Claude Code CLI

The CLI has the most control surface. Six levers are available, ranging from soft guidance to hard enforcement. Stack them for defense in depth.

## Prerequisites

- Claude Code CLI installed and authenticated
- SDL-MCP server added as a connected MCP server
- Confirm SDL-MCP is connected by running `/mcp` inside a Claude Code session

---

## Agent Install (Paste-and-Go)

If you want Claude Code to handle the entire setup for you, paste the following prompt into a Claude Code session running in your project root. It will create all six enforcement layers in one pass.

> **Before pasting:** Make sure SDL-MCP is already added as a connected MCP server. Run `/mcp` to confirm it shows as connected. The prompt below does not configure the MCP connection itself — only the enforcement files.

````text
I need you to set up SDL-MCP enforcement for this project. SDL-MCP is already connected as an MCP server. Your job is to create the files that force you (and any subagents) to use SDL-MCP tools instead of the native Read tool for source code files in supported languages. All other file types must remain readable through native Read.

SDL-MCP supported file extensions (block native Read for these only):
.ts .tsx .js .jsx .mjs .cjs .py .pyw .go .java .cs .c .h .cpp .hpp .cc .cxx .hxx .php .phtml .rs .kt .kts .sh .bash .zsh

Do the following steps in order:

1. CLAUDE.md — If CLAUDE.md exists in the project root, prepend the following block at the top (do not remove existing content). If it does not exist, create it. The block must contain:
   - A "Tool Usage Rules — SDL-MCP Enforcement" section
   - A rule stating NEVER use the built-in Read tool for source code files in SDL-MCP supported languages, use SDL-MCP tools instead
   - The full list of blocked extensions organized by language
   - A rule stating Read IS permitted for all other file types (.md, .json, .yaml, .yml, .toml, .xml, .sql, .css, .html, .txt, config files, lock files, etc.)
   - A rule stating if a Read attempt is denied by a hook, do NOT retry with Read — switch to SDL-MCP immediately
   - A rule stating when exploring the codebase or understanding code, use the explore-sdl subagent instead of the built-in Explore agent

2. .claude/hooks/force-sdl-mcp.sh — Create this bash script. It must:
   - Read JSON from stdin
   - Extract tool_name and file path from tool_input.file_path or tool_input.path
   - Only intercept the Read tool (exit 0 for anything else)
   - Exit 0 with no output if file path is empty (safety fallback)
   - Extract the file extension in lowercase
   - Define an array of all SDL-MCP supported extensions listed above
   - If the extension matches, output JSON to stdout with hookSpecificOutput.hookEventName="PreToolUse", hookSpecificOutput.permissionDecision="deny", and a permissionDecisionReason that tells you to use SDL-MCP tools (mcp__sdl-mcp__*) instead and that Read is only allowed for non-indexed file types
   - If the extension does not match, exit 0 (allow the read)
   - Make the script executable (chmod +x)

3. .claude/settings.json — Create or merge into the existing file. It must contain:
   - A permissions.deny array with Read(**.ext) entries for every SDL-MCP supported extension listed above
   - A permissions.deny entry for Task(Explore) to disable the built-in Explore agent
   - A permissions.allow array with Read(**.md) and mcp__sdl-mcp__*
   - A hooks.PreToolUse entry with matcher "Read" pointing to .claude/hooks/force-sdl-mcp.sh
   - A hooks.SessionStart entry that outputs JSON with an additionalContext field containing a message instructing you to use SDL-MCP tools for all source code in supported languages instead of native Read, that Read is only permitted for non-indexed file types, and to switch to SDL-MCP immediately if a Read call is denied

4. .claude/agents/explore-sdl.md — Create this subagent file with:
   - Frontmatter: name=explore-sdl, description about codebase exploration using SDL-MCP, tools=Grep Glob mcp__sdl-mcp__*, disallowedTools=Read, model=inherit
   - Body instructions: never use native Read for source code, always use SDL-MCP tools, may use Grep and Glob for file discovery, if a non-code file is needed ask the parent conversation to read it

5. .claude/sdl-prompt.md — Create this file for use with --append-system-prompt-file. It must contain:
   - An instruction to always use SDL-MCP tools for source code in supported languages instead of native Read
   - The full list of blocked extensions
   - A statement that native Read is only permitted for non-indexed file types (.md, .json, .yaml, .yml, .toml, .xml, .sql, .css, .html, .txt, config files, lock files, etc.)
   - A rule that if a Read call is denied, switch to SDL-MCP immediately — do not retry with Read
   - A rule to use explore-sdl subagent instead of the built-in Explore agent

After creating all files, show me the file tree of what was created and run /hooks to confirm the hooks are registered.
````

After the agent finishes, verify the setup using the [Verification](#claude-code-cli--verification) steps at the end of the CLI section.

---

## Lever 1: CLAUDE.md Instructions (Soft Guidance)

CLAUDE.md is loaded at the start of every Claude Code session and treated as standing instructions. This sets intent and gives Claude the reasoning behind the tool preference.

### Steps

1. Open or create `CLAUDE.md` in your project root.
2. Add the following block. Place it near the top so it is loaded early in context.

```markdown
## Tool Usage Rules — SDL-MCP Enforcement

- **NEVER use the built-in Read tool for source code files in SDL-MCP supported languages.**
  Use SDL-MCP tools instead. SDL-MCP has the entire codebase mapped and indexed including
  dependencies and is far more token and context efficient than native Read.

- **Supported languages (Read is BLOCKED for these file types):**
  TypeScript (.ts, .tsx), JavaScript (.js, .jsx, .mjs, .cjs), Python (.py, .pyw),
  Go (.go), Java (.java), C# (.cs), C (.c, .h), C++ (.cpp, .hpp, .cc, .cxx, .hxx),
  PHP (.php, .phtml), Rust (.rs), Kotlin (.kt, .kts), Shell (.sh, .bash, .zsh)

- **The Read tool IS permitted for all other file types** including .md, .json, .yaml, .yml,
  .toml, .xml, .sql, .css, .html, .txt, config files, lock files, and anything else not
  listed above.

- When you need to understand code structure, find definitions, trace dependencies, or read
  source files in supported languages, always use the SDL-MCP MCP tools.

- If a Read attempt on a supported language file is denied by a hook, do NOT retry with Read.
  Switch to SDL-MCP immediately.
```

3. Save the file.

### Scope

- **Project-level:** `<project-root>/CLAUDE.md`
- **Global (all projects):** `~/.claude/CLAUDE.md`

This lever alone is not enforcement — Claude can still attempt native Read. The hook in Lever 2 catches those attempts.

---

## Lever 2: PreToolUse Hook (Hard Enforcement)

This is the most reliable mechanism. The hook intercepts every `Read` tool call before execution, checks the file extension, and either allows it or denies it with a message telling Claude to use SDL-MCP instead. Claude sees the denial reason and self-corrects on the next attempt.

### Steps

1. Create the hooks directory if it does not exist:

```bash
mkdir -p .claude/hooks
```

2. Create the hook script at `.claude/hooks/force-sdl-mcp.sh`:

```bash
#!/bin/bash
set -euo pipefail

# Read JSON input from stdin
INPUT=$(cat)

TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name')
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // .tool_input.path // ""')

# Only intercept the Read tool
if [ "$TOOL_NAME" != "Read" ]; then
  exit 0
fi

# If no file path was extracted, allow it (safety fallback)
if [ -z "$FILE_PATH" ]; then
  exit 0
fi

# Extract the file extension (lowercase)
EXT=$(echo "$FILE_PATH" | sed 's/.*\./\./' | tr '[:upper:]' '[:lower:]')

# Define SDL-MCP supported extensions
SDL_EXTENSIONS=(
  # TypeScript
  ".ts" ".tsx"
  # JavaScript
  ".js" ".jsx" ".mjs" ".cjs"
  # Python
  ".py" ".pyw"
  # Go
  ".go"
  # Java
  ".java"
  # C#
  ".cs"
  # C
  ".c" ".h"
  # C++
  ".cpp" ".cc" ".cxx" ".hpp" ".hxx"
  # PHP
  ".php" ".phtml"
  # Rust
  ".rs"
  # Kotlin
  ".kt" ".kts"
  # Shell
  ".sh" ".bash" ".zsh"
)

# Check if extension is in the SDL-MCP supported list
for BLOCKED_EXT in "${SDL_EXTENSIONS[@]}"; do
  if [ "$EXT" = "$BLOCKED_EXT" ]; then
    jq -n '{
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "BLOCKED: The native Read tool is not permitted for source code files in SDL-MCP supported languages. Use SDL-MCP tools (mcp__sdl-mcp__*) instead. SDL-MCP has this file indexed and is more token-efficient. The Read tool is only allowed for non-indexed file types (.md, .json, .yaml, .xml, .css, .html, .txt, config files, etc.)."
      }
    }'
    exit 0
  fi
done

# Extension not in SDL-MCP list — allow the read
exit 0
```

3. Make the script executable:

```bash
chmod +x .claude/hooks/force-sdl-mcp.sh
```

4. Register the hook in `.claude/settings.json` (create the file if it does not exist). If the file already has content, merge the `hooks` key into the existing structure:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Read",
        "hooks": [
          {
            "type": "command",
            "command": ".claude/hooks/force-sdl-mcp.sh"
          }
        ]
      }
    ]
  }
}
```

5. Verify the hook is active by running `/hooks` inside a Claude Code session.

### How It Works

- Claude decides to call `Read` on a `.py` file.
- The `PreToolUse` event fires. The matcher `Read` matches, so the hook script runs.
- The script extracts the file extension, finds `.py` in the blocked list, and returns a JSON `permissionDecision: "deny"` with the reason.
- Claude sees the denial reason and switches to SDL-MCP on the next attempt.
- Claude decides to call `Read` on a `.md` file — the extension is not in the blocked list, the script exits `0`, and the read proceeds normally.

### Notes

- The `jq` command must be available on your system. It is pre-installed on most Linux distributions and macOS (via Homebrew).
- The hook timeout is 10 minutes (as of Claude Code v2.1.3), so there is no risk of timeout on this simple script.
- The `permissionDecisionReason` text is what Claude reads. Write it like an instruction — tell Claude what to do, not just what went wrong.

---

## Lever 3: Permission Deny Rules in settings.json (Belt and Suspenders)

Permission deny rules provide a declarative layer of enforcement. These rules use gitignore-style path patterns.

### Important Caveat

There has been a known issue (GitHub issue #6631, reported August 2025) where `Read` deny rules were not reliably enforced in some Claude Code versions. Bash deny rules work, but Read deny rules have been inconsistent. **Check your current Claude Code version.** This lever should be used in addition to the hook, not instead of it.

### Steps

1. Open `.claude/settings.json` (same file where the hook was registered).

2. Add or merge the `permissions` block:

```json
{
  "permissions": {
    "deny": [
      "Read(**.ts)",
      "Read(**.tsx)",
      "Read(**.js)",
      "Read(**.jsx)",
      "Read(**.mjs)",
      "Read(**.cjs)",
      "Read(**.py)",
      "Read(**.pyw)",
      "Read(**.go)",
      "Read(**.java)",
      "Read(**.cs)",
      "Read(**.c)",
      "Read(**.h)",
      "Read(**.cpp)",
      "Read(**.cc)",
      "Read(**.cxx)",
      "Read(**.hpp)",
      "Read(**.hxx)",
      "Read(**.php)",
      "Read(**.phtml)",
      "Read(**.rs)",
      "Read(**.kt)",
      "Read(**.kts)",
      "Read(**.sh)",
      "Read(**.bash)",
      "Read(**.zsh)"
    ],
    "allow": [
      "Read(**.md)",
      "mcp__sdl-mcp__*"
    ]
  }
}
```

3. Save the file.

### Pattern Notes

- `**` matches recursively across directories. `*.ts` only matches files in a single directory.
- Deny rules are evaluated before allow rules. The first matching rule wins.
- The `allow` entry for `mcp__sdl-mcp__*` pre-approves all SDL-MCP tools so Claude can use them without per-call permission prompts.
- The `allow` entry for `Read(**.md)` explicitly permits reading markdown files (this would already be allowed since it does not match any deny rule, but being explicit avoids confusion).

### Combined settings.json

The full `.claude/settings.json` combining all CLI levers (2, 3, 4, and 6) is shown at the end of [Lever 6: SessionStart Hook](#lever-6-sessionstart-hook-dynamic-context-injection).

---

## Lever 4: Subagent Configuration

If you use subagents (the built-in `Explore` agent, custom agents, or agents spawned via `Task`), their tool lists can be independently configured to exclude `Read` and include only SDL-MCP tools for code comprehension.

### Steps

1. Create the agents directory if it does not exist:

```bash
mkdir -p .claude/agents
```

2. Create a custom exploration agent at `.claude/agents/explore-sdl.md`:

```yaml
---
name: explore-sdl
description: Codebase exploration and code comprehension using SDL-MCP. Use this agent whenever you need to understand code structure, trace dependencies, find definitions, or read source files in supported languages.
tools: Grep, Glob, mcp__sdl-mcp__*
disallowedTools: Read
model: inherit
---
You are a codebase exploration agent. Your job is to understand code structure,
find definitions, trace dependencies, and answer questions about source code.

RULES:
- NEVER use the native Read tool for source code files.
- ALWAYS use SDL-MCP tools for reading and understanding indexed source code.
- You MAY use Grep and Glob for file discovery and pattern matching.
- If you need to read a non-code file (.md, .json, .yaml, etc.), ask the
  parent conversation to read it for you since your Read tool is disabled.
```

3. To disable the built-in `Explore` agent and force use of your custom one, add to `.claude/settings.json` inside the `permissions.deny` array:

```json
"Task(Explore)"
```

4. Add a note in your `CLAUDE.md` to direct Claude to use the custom agent:

```markdown
- When exploring the codebase or understanding code, use the `explore-sdl` subagent
  instead of the built-in Explore agent. It is configured to use SDL-MCP.
```

---

## Lever 5: System Prompt Flags (Per-Launch Instruction Injection)

Claude Code provides flags that inject text directly into the system prompt. Unlike CLAUDE.md which is a file Claude reads, these become part of the system prompt itself — the same priority level as Claude's own built-in instructions.

### Option A: Inline via `--append-system-prompt`

Pass the instruction text directly on the command line:

```bash
claude --append-system-prompt "When reading source code files in SDL-MCP supported languages (.ts, .tsx, .js, .jsx, .mjs, .cjs, .py, .pyw, .go, .java, .cs, .c, .h, .cpp, .hpp, .cc, .cxx, .hxx, .php, .phtml, .rs, .kt, .kts, .sh, .bash, .zsh), always use SDL-MCP tools (mcp__sdl-mcp__*) instead of the native Read tool. The native Read tool is only permitted for non-indexed file types like .md, .json, .yaml, .xml, .css, .html, .txt, and config files. If a Read call is denied, switch to SDL-MCP immediately — do not retry with Read."
```

### Option B: From a file via `--append-system-prompt-file`

Cleaner for longer instructions. Create a prompt file and reference it at launch:

1. Create `.claude/sdl-prompt.md` in your project:

```markdown
When reading source code files in SDL-MCP supported languages, always use SDL-MCP
tools (mcp__sdl-mcp__*) instead of the native Read tool.

SDL-MCP supported extensions (native Read is BLOCKED for these):
.ts .tsx .js .jsx .mjs .cjs .py .pyw .go .java .cs .c .h .cpp .hpp .cc .cxx .hxx
.php .phtml .rs .kt .kts .sh .bash .zsh

The native Read tool is only permitted for non-indexed file types: .md, .json, .yaml,
.yml, .toml, .xml, .sql, .css, .html, .txt, config files, lock files, and anything
not listed above.

If a Read call on a supported language file is denied by a hook, do NOT retry with
Read. Switch to SDL-MCP immediately.

When exploring the codebase or understanding code, use the explore-sdl subagent
instead of the built-in Explore agent.
```

2. Launch Claude Code with the flag:

```bash
claude --append-system-prompt-file .claude/sdl-prompt.md
```

### Notes

- Both flags preserve all default Claude Code instructions and append your text on top. They do not replace the system prompt.
- There is also `--system-prompt` (without "append") which replaces the entire system prompt with your text, removing all default Claude Code behavior. Do not use that here.
- `--append-system-prompt` and `--append-system-prompt-file` are mutually exclusive. Use one or the other.
- To make this the default for every launch without typing the flag, create a shell alias:

```bash
alias claude='claude --append-system-prompt-file .claude/sdl-prompt.md'
```

- This is still a soft mechanism. The instruction is in the system prompt but Claude can still attempt native Read. The PreToolUse hook (Lever 2) catches those attempts.

---

## Lever 6: SessionStart Hook (Dynamic Context Injection)

A `SessionStart` hook runs at the beginning of every session (startup, resume, clear, compact) and can inject `additionalContext` that Claude sees and acts on. Unlike a static file, this can include dynamic content — though for SDL-MCP enforcement a static message is all that's needed.

### Steps

1. Add the following to your `.claude/settings.json` inside the `hooks` object, alongside the existing `PreToolUse` hook:

```json
"SessionStart": [
  {
    "hooks": [
      {
        "type": "command",
        "command": "echo '{\"additionalContext\": \"IMPORTANT: For all source code in SDL-MCP supported languages (.ts, .tsx, .js, .jsx, .mjs, .cjs, .py, .pyw, .go, .java, .cs, .c, .h, .cpp, .hpp, .cc, .cxx, .hxx, .php, .phtml, .rs, .kt, .kts, .sh, .bash, .zsh), use SDL-MCP tools (mcp__sdl-mcp__*) instead of the native Read tool. Read is only permitted for non-indexed file types (.md, .json, .yaml, .xml, .css, .html, .txt, config files, etc.). If a Read call is denied, switch to SDL-MCP immediately.\"}'"
      }
    ]
  }
]
```

2. The `additionalContext` output from `SessionStart` hooks is added as context that Claude can see and act on before processing the first user message.

### When to Use This Instead of Lever 5

- Lever 5 (`--append-system-prompt-file`) requires a flag at launch. If you forget the flag, the instruction is missing.
- Lever 6 (`SessionStart` hook) is configured in `settings.json` and runs automatically every session with no flags needed.
- If you want both: they stack. The system prompt instruction arrives first, then the SessionStart context reinforces it.

### Combined settings.json (All CLI Levers)

Here is the full `.claude/settings.json` with the PreToolUse hook (Lever 2), permission rules (Lever 3), the `Task(Explore)` deny (Lever 4), and the SessionStart hook (Lever 6):

```json
{
  "permissions": {
    "deny": [
      "Read(**.ts)",
      "Read(**.tsx)",
      "Read(**.js)",
      "Read(**.jsx)",
      "Read(**.mjs)",
      "Read(**.cjs)",
      "Read(**.py)",
      "Read(**.pyw)",
      "Read(**.go)",
      "Read(**.java)",
      "Read(**.cs)",
      "Read(**.c)",
      "Read(**.h)",
      "Read(**.cpp)",
      "Read(**.cc)",
      "Read(**.cxx)",
      "Read(**.hpp)",
      "Read(**.hxx)",
      "Read(**.php)",
      "Read(**.phtml)",
      "Read(**.rs)",
      "Read(**.kt)",
      "Read(**.kts)",
      "Read(**.sh)",
      "Read(**.bash)",
      "Read(**.zsh)",
      "Task(Explore)"
    ],
    "allow": [
      "Read(**.md)",
      "mcp__sdl-mcp__*"
    ]
  },
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Read",
        "hooks": [
          {
            "type": "command",
            "command": ".claude/hooks/force-sdl-mcp.sh"
          }
        ]
      }
    ],
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "echo '{\"additionalContext\": \"IMPORTANT: For all source code in SDL-MCP supported languages (.ts, .tsx, .js, .jsx, .mjs, .cjs, .py, .pyw, .go, .java, .cs, .c, .h, .cpp, .hpp, .cc, .cxx, .hxx, .php, .phtml, .rs, .kt, .kts, .sh, .bash, .zsh), use SDL-MCP tools (mcp__sdl-mcp__*) instead of the native Read tool. Read is only permitted for non-indexed file types (.md, .json, .yaml, .xml, .css, .html, .txt, config files, etc.). If a Read call is denied, switch to SDL-MCP immediately.\"}'"
          }
        ]
      }
    ]
  }
}
```

---

## Claude Code CLI — Verification

After completing setup, test each lever:

1. **Hook test**: Ask Claude Code to read a `.py` or `.ts` file directly. It should be denied and Claude should switch to SDL-MCP.
2. **Allowlist test**: Ask Claude Code to read a `.md` file. It should succeed through native Read.
3. **Subagent test**: Ask Claude to explore the codebase using the `explore-sdl` agent and confirm it uses SDL-MCP tools.
4. **SessionStart test**: Start a new session and toggle verbose mode (`Ctrl+O`). The SessionStart hook output should be visible at the top.
5. **Verbose mode**: With `Ctrl+O` enabled, hook execution output and permission decisions are visible for all subsequent tool calls.

---

## Claude Code CLI — File Summary

After completing this guide, your project should contain:

```
<project-root>/
├── CLAUDE.md                          # Lever 1 — soft guidance
├── .claude/
│   ├── settings.json                  # Levers 2, 3, 4, 6 — hooks + permissions + SessionStart
│   ├── sdl-prompt.md                  # Lever 5 — system prompt file (optional, used with --append-system-prompt-file)
│   ├── hooks/
│   │   └── force-sdl-mcp.sh          # Lever 2 — hard enforcement script
│   └── agents/
│       └── explore-sdl.md            # Lever 4 — SDL-MCP-only subagent
└── .mcp.json                          # SDL-MCP server connection (already configured)
```

---

---

# Claude.ai (Web App / Desktop App)

Claude.ai does not have hooks, settings.json, permission deny rules, system prompt flags, or SessionStart hooks. There is no enforcement mechanism — only guidance. SDL-MCP tool use can be encouraged but not guaranteed.

## What You Can Do

### 1. Project Instructions (System Prompt)

This is the strongest lever available in the web and desktop interfaces. If you are using a Claude Project, paste the instruction text from Lever 1 (the CLAUDE.md block) into the project's custom instructions field.

To access this in Claude.ai:

1. Open or create a Project.
2. Click the project name to open project settings.
3. Paste the SDL-MCP enforcement instructions into the **Custom Instructions** field.

Claude will see these instructions at the start of every conversation within that project.

### 2. Connect SDL-MCP as a Remote MCP Server

Claude.ai supports connecting MCP servers. Once connected, Claude will see the SDL-MCP tools and can use them. The connection method depends on your platform:

- **Claude Desktop App**: Edit `claude_desktop_config.json` (accessible via Developer settings) to add the SDL-MCP server entry under `mcpServers`.
- **Claude.ai Web**: MCP server connections are configured through the integrations interface if available on your plan.

After connecting, Claude will have access to SDL-MCP tools alongside its native tools. It will choose between them based on the task and any instructions in the project system prompt.

### 3. SDL-MCP Tool Descriptions

On the MCP server side, make tool descriptions clearly communicate the advantage over native Read. Claude selects tools partly based on how well the tool description matches the task. Descriptions like these increase the likelihood that Claude chooses SDL-MCP:

- *"Reads source code with full dependency context and codebase-wide indexing. More efficient than reading files individually."*
- *"Searches the indexed codebase for symbol definitions, references, and dependency chains across all supported languages."*

This is prompt engineering at the tool-description level. It does not guarantee selection, but it biases Claude toward the better tool when the descriptions are specific.

## What You Cannot Do

- Block or deny native tool access
- Run hooks or lifecycle scripts
- Configure permission rules or deny lists
- Inject system prompt text automatically (must be done manually per-project)
- Prevent Claude from using native Read even when SDL-MCP is available

The web and desktop apps will use SDL-MCP tools when prompted or when the tool description is a strong match, but there is no enforcement mechanism. If hard enforcement is required, use Claude Code CLI.

---

---

# Maintenance

- When SDL-MCP adds support for new languages, update the extension list in these locations:
  - `CLAUDE.md` instructions (Lever 1)
  - `.claude/hooks/force-sdl-mcp.sh` extension array (Lever 2)
  - `.claude/settings.json` permission deny rules (Lever 3)
  - `.claude/sdl-prompt.md` if using Lever 5
  - `.claude/settings.json` SessionStart hook message (Lever 6)
  - Claude.ai project instructions if using the web/desktop app
- When Claude Code resolves the Read deny rule enforcement issue (GitHub #6631), the permission rules in Lever 3 become a reliable standalone fallback. The PreToolUse hook remains the primary enforcement regardless.
- CLI settings are project-scoped by default. To apply globally, place `settings.json` at `~/.claude/settings.json`, the hook at `~/.claude/hooks/force-sdl-mcp.sh`, agents at `~/.claude/agents/`, and the prompt file at `~/.claude/sdl-prompt.md`.
- Claude.ai project instructions must be updated manually per-project. There is no global equivalent.