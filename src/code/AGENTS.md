# src/code/ - Code Access Layer

## OVERVIEW
Provides gated access to raw source code through a 4-rung context ladder: cards (always), skeleton, hot-path, full window (gated).

## KEY FILES

| File | Purpose |
|------|---------|
| `skeleton.ts` | Deterministic skeleton IR (signatures + control flow + elided bodies) |
| `hotpath.ts` | Hot-path excerpt (lines matching identifiers with context) |
| `windows.ts` | Raw code window extraction |
| `gate.ts` | Policy gate for code access (proof-of-need evaluation) |
| `redact.ts` | Content redaction |

## CONTEXT LADDER (4 rungs)
1. **Symbol Cards** - always available, minimal tokens
2. **Skeleton IR** - deterministic code outline
3. **Hot-Path Excerpt** - critical code paths only
4. **Full Window** - gated, requires justification

## CONVENTIONS
- Always try `getSkeleton` before `getHotPath` before `needWindow`
- `needWindow` requires: `reason`, `expectedLines`, `identifiersToFind`
- Policy gate checks: identifiers exist in range, symbol in slice/frontier, scorer utility > threshold
- Denial responses include actionable guidance
- `maxWindowLines`: 180, `maxWindowTokens`: 1400 (policy defaults)
