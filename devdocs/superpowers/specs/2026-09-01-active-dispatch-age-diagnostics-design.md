# Active Dispatch Age Diagnostics

## Goal

When a tool dispatch queue timeout occurs, log enough bounded evidence to
identify which admitted tool calls are still running, how long they have run,
and whether their request signal has been aborted.

## Design

Keep the existing active-label counts and public timeout error unchanged. Add
a private per-invocation registry in `src/mcp/dispatch-limiter.ts` containing:

- the existing tool label;
- the admission time in milliseconds; and
- the request `AbortSignal`, when one exists.

Register an invocation only after the shared limiter admits it. Remove the
record in the same `finally` block that clears the active label. Reset the
registry with the existing limiter reset function.

On a dispatch queue timeout, take one oldest-first snapshot capped at 32
entries. Log each entry as:

```text
{ label, ageMs, cancellationState }
```

`cancellationState` is `none`, `active`, or `aborted`. Log the number of
omitted entries separately. Do not add timers, periodic logging, public MCP
fields, timestamps, or changes to dispatch/cancellation behavior.

## Verification

Focused unit tests must fail before implementation and then prove:

1. admitted invocations report label, age, and cancellation state;
2. snapshots are oldest-first and capped with an omitted count;
3. completed work and limiter reset clear diagnostic records; and
4. existing active-label counts and timeout errors remain unchanged.

Run the focused dispatch-limiter tests, typecheck, lint, and the repository's
test-scope verification. No index refresh is required.
