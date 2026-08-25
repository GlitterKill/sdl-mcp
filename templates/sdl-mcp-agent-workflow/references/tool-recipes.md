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

When `sdl.context` returns a response artifact handle, continue directly through
`sdl.retrieve` and request only the needed canonical field or page:

```json
{
  "repoId": "my-repo",
  "op": "responseGet",
  "args": {
    "handle": "response-my-repo-...",
    "jsonPath": "evidence",
    "offset": 0,
    "limit": 10
  }
}
```

Use `cursor` and `maxBytes` for byte paging. Use workflow `responseGet` only
when an existing multi-step workflow needs to pipe the retrieved result.
