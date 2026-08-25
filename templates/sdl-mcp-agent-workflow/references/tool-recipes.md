# SDL-MCP Tool Recipes

## Focused Debug

```json
{
  "repoId": "my-repo",
  "taskType": "debug",
  "taskText": "Debug the handleAgentContext handler",
  "budget": { "maxTokens": 4000 },
  "focusSymbols": ["handleAgentContext"],
  "chatMentions": ["handleAgentContext"],
  "includeTests": true,
  "responseMode": "auto"
}
```

## Subsystem Explanation

```json
{
  "repoId": "my-repo",
  "taskType": "explain",
  "taskText": "Explain request dispatch from entrypoint to tool handlers",
  "budget": { "maxTokens": 7000 },
  "includeTests": false,
  "responseMode": "auto"
}
```

## Large-Response Recovery

When a result returns a canonical `response.get` continuation (`nextAction` or
`action`) for `sdl.retrieve` with `op: "responseGet"`, replay the returned action
and arguments unchanged; do not reconstruct the continuation. A direct
continuation has this shape:

```json
{
  "repoId": "my-repo",
  "op": "responseGet",
  "args": {
    "handle": "response-my-repo-...",
    "jsonPath": "evidence",
    "offset": 0,
    "limit": 10
  },
  "detail": "full",
  "includeDiagnostics": true
}
```

The outer `repoId` owns trusted dispatch. `detail` and `includeDiagnostics` are
outer `sdl.retrieve` controls; nested `args` contains only artifact view and
paging fields, and nested `repoId` is invalid. Use `cursor` and `maxBytes` for
byte paging. Use workflow `responseGet` only when direct `sdl.retrieve` is
unavailable or an existing multi-step workflow needs to pipe the result.
