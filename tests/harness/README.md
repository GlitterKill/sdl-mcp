# SDL-MCP Test Harness

This directory contains the test harness for SDL-MCP, which verifies compatibility with various MCP clients.

## Usage

Run the full test harness suite:

```bash
npm run test:harness
```

Run with a custom configuration:

```bash
npm run test:harness -- --config=path/to/sdlmcp.config.json
```

## Structure

- `runner.ts` - Main test runner that starts the server and executes golden tasks
- `client-assertions.ts` - Client profile validation logic
- `../golden/*.json` - Golden task fixtures for each MCP tool

## What It Tests

1. **Tool Discovery** - Verifies all expected tools are available
2. **Schema Compatibility** - Validates input/output schemas match expectations
3. **Golden Tasks** - Executes a sequence of representative tasks:
   - Register repository
   - Index repository
   - Build graph slice
   - Get symbol card
   - Get code skeleton
   - Get delta pack
   - Request code window

## Client Profiles

The harness tests compatibility with:

- Claude Code
- Codex CLI
- Gemini CLI
- Opencode CLI

## Output

The harness produces a pass/fail report per client profile with:

- Tool discovery results
- Golden task execution results
- Duration metrics
- Detailed error messages

## Exit Codes

- `0` - All client profiles passed
- `1` - One or more client profiles failed
