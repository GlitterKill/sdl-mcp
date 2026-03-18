# SDL-MCP Memory Protocol

## When to Store Memories

Store via `sdl.memory.store` at these checkpoints:

| Checkpoint | Type | What to Capture |
|-----------|------|-----------------|
| Architectural decision made | decision | Decision, alternatives considered, rationale |
| Bug root cause identified | bugfix | Symptoms, root cause, fix applied, prevention |
| Code review completed | task_context | Findings, deferred work, TODOs |
| Performance issue found | bugfix | Bottleneck, measurement, fix/workaround |
| Feature implementation done | decision | Design choices, patterns used, trade-offs |
| Debugging session ended | bugfix | Investigation path, dead ends, resolution |
| Dependency/config gotcha | task_context | Gotcha, workaround, affected files |

## What Makes a Good Memory

- **Title**: Action-oriented, scannable (e.g., "Use nullish() not optional() for nullable config values")
- **Content**: 2-5 sentences. Include the *why*, not just the *what*
- **symbolIds**: Link to involved symbols (find via `sdl.symbol.search`)
- **fileRelPaths**: Link to involved files
- **tags**: 2-4 descriptive tags
- **confidence**: 0.9 for verified facts, 0.7 for hypotheses, 0.5 for hunches

## When Memories Are Surfaced

- **At session start**: `sdl.repo.status` auto-includes relevant memories
- **During slice builds**: `sdl.slice.build` auto-includes up to 5 related memories based on symbol overlap
- **On demand**: Call `sdl.memory.surface` with relevant symbolIds for deeper context

## Responding to Memory Hints

When a tool response includes `_memoryHint`, evaluate whether to store a memory.
The hint suggests a type and context — draft a memory and call `sdl.memory.store`.

Do not ignore hints. They indicate patterns worth capturing:
- Deep debugging sessions (3+ code window requests)
- Code review completions
- Large indexing changes (>10 files)
- Feature implementation completions

## Example

After fixing a bug:

```
sdl.memory.store({
  repoId: "<repo>",
  type: "bugfix",
  title: "better-sqlite3 .get() returns undefined not null",
  content: "When querying for a missing row, better-sqlite3 returns undefined, not null. Use ?? null when the caller expects null. This caused silent failures in getSymbolCard when the symbol was deleted between index runs.",
  fileRelPaths: ["src/db/queries.ts"],
  tags: ["sqlite", "null-handling"],
  confidence: 0.95
})
```

After an architectural decision:

```
sdl.memory.store({
  repoId: "<repo>",
  type: "decision",
  title: "Use LadybugDB graph database instead of SQLite for symbol storage",
  content: "Migrated from SQLite to LadybugDB (embedded graph DB) for symbol storage. Graph queries for slice building are 3-5x faster with native path traversal. Trade-off: less tooling ecosystem, but the query patterns fit graph semantics better.",
  symbolIds: ["<symbolId-for-buildSlice>"],
  tags: ["architecture", "database", "performance"],
  confidence: 0.9
})
```
