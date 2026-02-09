# Agent Autopilot

<div align="right">
<details>
<summary><strong>Docs Navigation</strong></summary>

- [Overview](../README.md)
- [Documentation Hub](./README.md)
  - [Getting Started](./getting-started.md)
  - [CLI Reference](./cli-reference.md)
  - [MCP Tools Reference](./mcp-tools-reference.md)
  - [Configuration Reference](./configuration-reference.md)
  - [Agent Workflows](./agent-workflows.md)
  - [Troubleshooting](./troubleshooting.md)
- [Legacy User Guide](./USER_GUIDE.md)

</details>
</div>

The Agent Autopilot provides automated task orchestration with intelligent rung path selection, evidence collection, and policy-governed code access.

## Overview

The Agent Autopilot (`sdl.agent.orchestrate`) is an intelligent execution engine that:

- Automatically selects the optimal "rung path" for code context retrieval
- Collects structured evidence from multiple sources
- Enforces policy decisions for code access (escalation/denial/downgrade)
- Provides actionable answers and next steps
- Tracks execution metrics for analysis

## Rung Ladder

The autopilot uses a ladder of increasingly detailed context levels:

| Rung         | Description                                | Use Case                                   | Approx. Tokens |
| ------------ | ------------------------------------------ | ------------------------------------------ | -------------- |
| **card**     | Symbol summaries, signatures, dependencies | High-level understanding, explain tasks    | 50             |
| **skeleton** | Control flow, elided bodies                | Structure analysis, code review            | 200            |
| **hotPath**  | Matching lines with context                | Debugging, focused analysis                | 500            |
| **raw**      | Full source code                           | Deep inspection (requires policy approval) | 2000           |

## Task Types

### 1. Explain

**Best for**: Understanding code structure and relationships

**Default Rung Path**: `card` → `skeleton` (if focused symbols provided)

**Example**:

```json
{
  "repoId": "my-repo",
  "taskType": "explain",
  "taskText": "Explain how the authentication flow works",
  "options": {
    "focusSymbols": ["auth:authenticateUser"]
  }
}
```

**Response**:

- Structured answer summarizing the code
- Evidence from symbol cards and skeletons
- No raw code access needed

### 2. Review

**Best for**: Code quality analysis, security review

**Default Rung Path**: `card` → `skeleton` → `hotPath` (if focused symbols) → `hotPath` (if tests)

**Example**:

```json
{
  "repoId": "my-repo",
  "taskType": "review",
  "taskText": "Review the data access layer for security issues",
  "options": {
    "focusPaths": ["src/data"],
    "includeTests": true
  }
}
```

### 3. Debug

**Best for**: Investigating issues, error analysis

**Default Rung Path**: `card` → `skeleton` → `hotPath` → `raw` (if diagnostics required)

**Example**:

```json
{
  "repoId": "my-repo",
  "taskType": "debug",
  "taskText": "Debug the failing login function",
  "options": {
    "requireDiagnostics": true,
    "focusSymbols": ["auth:loginUser"]
  }
}
```

**Policy Behavior**:

- Raw code access is denied by default
- Downgraded to `hotPath` or `skeleton` based on policy
- `nextBestAction` indicates the downgrade target

### 4. Implement

**Best for**: Planning code changes, feature development

**Default Rung Path**: `card` → `skeleton` → `hotPath` (if focus paths provided)

**Example**:

```json
{
  "repoId": "my-repo",
  "taskType": "implement",
  "taskText": "Add error handling to API endpoint handlers",
  "options": {
    "focusSymbols": ["api:handleRequest", "api:validateInput"],
    "focusPaths": ["src/api/handlers"]
  }
}
```

## Budget Constraints

Control resource usage with budget parameters:

```json
{
  "repoId": "my-repo",
  "taskType": "explain",
  "taskText": "Explain the caching strategy",
  "budget": {
    "maxTokens": 1000,
    "maxActions": 5,
    "maxDurationMs": 3000
  }
}
```

**Behavior**:

- `maxTokens`: Rungs are removed from the end of the path if estimated tokens exceed this
- `maxActions`: Maximum number of MCP tool calls to execute
- `maxDurationMs`: Maximum allowed execution time in milliseconds

## Options

### Focus Symbols

Direct the autopilot to specific symbols:

```json
{
  "options": {
    "focusSymbols": ["auth:authenticateUser", "auth:validateToken"]
  }
}
```

### Focus Paths

Direct the autopilot to specific file paths:

```json
{
  "options": {
    "focusPaths": ["src/api", "src/data"]
  }
}
```

### Include Tests

Include test files in the context:

```json
{
  "options": {
    "includeTests": true
  }
}
```

**Effect**: Adds `hotPath` rung for test files in review tasks.

### Require Diagnostics

Require diagnostic information (error/warning) collection:

```json
{
  "options": {
    "requireDiagnostics": true
  }
}
```

**Effect**: Adds `raw` rung to debug tasks (subject to policy).

## Policy Enforcement

### Default Behavior

Raw code access is denied by default (`defaultDenyRaw: true`).

**What happens when raw access is denied**:

1. The autopilot attempts to access raw code
2. Policy engine evaluates the request
3. Request is denied or downgraded based on configuration
4. Evidence captures the policy decision
5. `nextBestAction` field suggests an alternative

### Downgrade Levels

| Decision                | Description                            | Suggested Next Action |
| ----------------------- | -------------------------------------- | --------------------- |
| `deny`                  | Access completely blocked              | `refineRequest`       |
| `downgrade-to-skeleton` | Downgrade to skeleton view             | `requestSkeleton`     |
| `downgrade-to-hotpath`  | Downgrade to hot path with identifiers | `requestHotPath`      |

### Override Policy (Break Glass)

Override policy denial with a special reason:

```json
{
  "taskType": "debug",
  "taskText": "AUDIT: Critical security investigation requiring raw access"
}
```

**Note**: Requires `allowBreakGlass: true` in policy configuration.

## Response Structure

```json
{
  "taskId": "task-1234567890-abc123",
  "taskType": "explain",
  "actionsTaken": [
    {
      "id": "action-0-1234567890",
      "type": "getCard",
      "status": "completed",
      "input": { "context": ["symbol:auth:authenticateUser"] },
      "output": { "cardsProcessed": 1 },
      "timestamp": 1234567890,
      "durationMs": 10,
      "evidence": []
    }
  ],
  "path": {
    "rungs": ["card", "skeleton"],
    "estimatedTokens": 250,
    "estimatedDurationMs": 60,
    "reasoning": "Explain task starts with high-level summaries"
  },
  "finalEvidence": [
    {
      "type": "symbolCard",
      "reference": "auth:authenticateUser",
      "summary": "Card for symbol auth:authenticateUser",
      "timestamp": 1234567890
    }
  ],
  "summary": "Task \"explain\" completed successfully. Executed 2 action(s), collected 3 evidence item(s).",
  "answer": "Based on the collected evidence from 3 sources, the code structure and relationships have been analyzed. Review the evidence sections for detailed information.",
  "success": true,
  "metrics": {
    "totalDurationMs": 65,
    "totalTokens": 250,
    "totalActions": 2,
    "successfulActions": 2,
    "failedActions": 0,
    "cacheHits": 0
  },
  "nextBestAction": null
}
```

## Fields

### taskId

Unique identifier for this task execution.

### actionsTaken

Array of actions executed. Each action includes:

- `id`: Action identifier
- `type`: Action type (`getCard`, `getSkeleton`, `getHotPath`, `needWindow`, `search`, `analyze`)
- `status`: Execution status (`pending`, `inProgress`, `completed`, `failed`)
- `input`: Input parameters
- `output`: Output result
- `error`: Error message if failed
- `timestamp`: Execution timestamp
- `durationMs`: Execution duration
- `evidence`: Evidence collected by this action

### path

Rung path selected for execution:

- `rungs`: Ordered array of rung types
- `estimatedTokens`: Estimated total tokens
- `estimatedDurationMs`: Estimated total duration
- `reasoning`: Explanation of path selection

### finalEvidence

Array of evidence items collected during execution.

### summary

Human-readable summary of execution.

### answer

Answer to the task based on collected evidence. Format varies by task type.

### success

Whether execution was successful (all actions completed without errors).

### error

Error message if execution failed.

### metrics

Execution metrics:

- `totalDurationMs`: Total execution time
- `totalTokens`: Estimated tokens processed
- `totalActions`: Total actions executed
- `successfulActions`: Actions that succeeded
- `failedActions`: Actions that failed
- `cacheHits`: Policy cache hits (denied/downgraded requests)

### nextBestAction

Suggested next action based on execution results and policy decisions:

- `requestSkeleton`: Request skeleton view instead of raw code
- `requestHotPath`: Request hot path with identifiers
- `refineRequest`: Refine the original request
- `null`: No suggested action (task completed successfully)

## Usage Patterns

### Pattern 1: Quick Explanation

```json
{
  "repoId": "my-repo",
  "taskType": "explain",
  "taskText": "What does this function do?",
  "options": {
    "focusSymbols": ["utils:processData"]
  }
}
```

**Result**: Fast explanation using card rung only (~50 tokens).

### Pattern 2: Deep Investigation

```json
{
  "repoId": "my-respo",
  "taskType": "debug",
  "taskText": "Investigate performance bottleneck",
  "budget": {
    "maxTokens": 5000
  },
  "options": {
    "requireDiagnostics": true,
    "focusPaths": ["src/performance"]
  }
}
```

**Result**: Full ladder execution with policy-governed raw access.

### Pattern 3: Focused Review

```json
{
  "repoId": "my-repo",
  "taskType": "review",
  "taskText": "Check for SQL injection vulnerabilities",
  "options": {
    "focusSymbols": ["db:query", "db:execute"],
    "focusPaths": ["src/database"]
  }
}
```

**Result**: Targeted review of specific symbols using skeleton + hotPath.

### Pattern 4: Change Planning

```json
{
  "repoId": "my-repo",
  "taskType": "implement",
  "taskText": "Add rate limiting to API endpoints",
  "budget": {
    "maxTokens": 1500,
    "maxActions": 10
  },
  "options": {
    "focusPaths": ["src/api/middleware"]
  }
}
```

**Result**: Context collection for implementation using card + skeleton + hotPath.

### Pattern 5: Policy-Aware Debugging

```json
{
  "repoId": "my-repo",
  "taskType": "debug",
  "taskText": "Debug failing integration test",
  "options": {
    "includeTests": true,
    "focusSymbols": ["test:apiIntegration"]
  }
}
```

**Result**: Debugging with test context, policy enforcement on raw access.

## Constraints and Limitations

### 1. Raw Code Access

- **Default**: Denied
- **Override**: Break glass with `AUDIT:` or `BREAK-GLASS:` in task text
- **Policy Control**: `allowBreakGlass`, `defaultDenyRaw`

### 2. Budget Enforcement

- Rung paths are pruned from the end to meet budget constraints
- Minimum of 1 rung is always maintained
- Budgets are estimated, actual usage may vary

### 3. Symbol Resolution

- Symbols must be indexed before use in `focusSymbols`
- Use `sdl.symbol.search` to find valid symbol IDs
- Invalid symbols are silently skipped

### 4. Path Resolution

- Paths are relative to repository root
- Use forward slashes regardless of OS
- Wildcards are not supported

### 5. Execution Limits

- Maximum actions enforced by `budget.maxActions`
- Maximum duration enforced by `budget.maxDurationMs`
- Timeout causes task to fail with partial results

## Troubleshooting

### Issue: No evidence collected

**Cause**: Invalid symbols or paths in options

**Solution**:

1. Verify symbols exist: `sdl.symbol.search`
2. Check paths are correct
3. Remove invalid options

### Issue: Raw access denied

**Cause**: Policy enforcement

**Solution**:

1. Check `nextBestAction` field for suggestion
2. Add identifiers to get `hotPath` instead
3. Use break glass if absolutely necessary

### Issue: Task exceeds budget

**Cause**: Estimated tokens exceed budget

**Solution**:

1. Increase `budget.maxTokens`
2. Reduce scope (fewer symbols/paths)
3. Simplify task requirements

### Issue: Partial execution

**Cause**: Error or timeout during execution

**Solution**:

1. Check `failedActions` count in metrics
2. Review action errors in `actionsTaken`
3. Increase `budget.maxDurationMs` if timeout

### Issue: No nextBestAction

**Cause**: Task completed successfully without policy denials

**Solution**: This is expected behavior. `nextBestAction` is only populated when policy decisions suggest alternatives.

## Integration Examples

### With Claude Code

```typescript
const response = await mcpClient.callTool({
  name: "sdl.agent.orchestrate",
  arguments: {
    repoId: "my-project",
    taskType: "explain",
    taskText: "Explain the authentication flow",
  },
});

console.log(response.answer);
console.log(response.nextBestAction);
```

### Loop with Next Best Action

```typescript
async function executeWithFallback(task) {
  let result = await mcpClient.callTool({
    name: "sdl.agent.orchestrate",
    arguments: task,
  });

  while (result.nextBestAction) {
    switch (result.nextBestAction) {
      case "requestSkeleton":
        result = await mcpClient.callTool({
          name: "sdl.code.getSkeleton",
          arguments: {
            repoId: task.repoId,
            symbolId: task.options.focusSymbols[0],
          },
        });
        break;
      case "requestHotPath":
        result = await mcpClient.callTool({
          name: "sdl.code.getHotPath",
          arguments: {
            repoId: task.repoId,
            symbolId: task.options.focusSymbols[0],
            identifiersToFind: ["function", "class"],
          },
        });
        break;
      case "refineRequest":
        console.log("Refine the request: fewer symbols, less scope");
        return result;
      default:
        return result;
    }
  }

  return result;
}
```

## Performance Considerations

### Token Efficiency

- Use `explain` tasks for quick understanding (card-only)
- Avoid `requireDiagnostics` unless needed (adds raw rung)
- Set realistic budgets to avoid unnecessary rungs

### Execution Speed

- Card rungs are fastest (~10ms)
- Skeleton rungs are moderate (~50ms)
- HotPath rungs are slower (~100ms)
- Raw rungs are slowest (~500ms)

### Cache Hits

Policy denials are cached and reported as `cacheHits` in metrics. High cache counts indicate frequent policy enforcement.

## Best Practices

1. **Start Simple**: Use `explain` with `focusSymbols` for quick understanding
2. **Use Budgets**: Always set `maxTokens` to control context size
3. **Be Specific**: Provide `focusSymbols` and `focusPaths` to reduce scope
4. **Check Next Action**: Always check `nextBestAction` for policy guidance
5. **Review Evidence**: Use `finalEvidence` for detailed information
6. **Handle Errors**: Check `success` and `error` fields before using results

## Policy Configuration

Configure policy behavior via `sdl.policy.set`:

```json
{
  "repoId": "my-repo",
  "policyPatch": {
    "allowBreakGlass": false,
    "defaultDenyRaw": true,
    "requireIdentifiers": true
  }
}
```

**Settings**:

- `allowBreakGlass`: Allow break glass override (default: `true`)
- `defaultDenyRaw`: Deny raw code access by default (default: `true`)
- `requireIdentifiers`: Require identifiers for raw/hotPath access (default: `true`)

## Related Documentation

- [MCP Tools Documentation](./MCP_TOOLS.md)
- [Policy Engine](./POLICY_ENGINE.md)
- [Code Access Rungs](./CODE_RUNGS.md)
- [Testing Guide](./TESTING.md)
