# TASKS.md - SDL-MCP v0.6 Execution Coordination

Last Modified: 2026-02-08
Phase: v0.6 Planning and Execution

## Source PRDs

1. `devdocs/SDL-MCP_v0.6.md`
2. `devdocs/SDL-MCP_Hosted_Cloud_Explore_PRD.md` (explore only, not in v0.6 execution scope)

## Kanban Project

- Name: `sdl-mcp`
- Project ID: `1a2950de-4c3a-4674-b488-337e26d82fdf`

## Task Registry (v0.6)

| ID     | Task                                                                  | Status      | Depends On                         | Kanban Task ID                         | Recommended Agent Lane |
| ------ | --------------------------------------------------------------------- | ----------- | ---------------------------------- | -------------------------------------- | ---------------------- |
| V06-1  | PR Risk Copilot Core - risk model and analysis pipeline               | IN_PROGRESS | None                               | `74e4ba41-0207-44e3-8f80-4056dc8be059` | Lane A                 |
| V06-2  | PR Risk Copilot Tool - MCP endpoint, harness tests, docs              | TODO        | V06-1                              | `51a8659e-4600-4776-a2e1-6ab19f16f959` | Lane A                 |
| V06-3  | Agent Autopilot Core - orchestration planner and execution flow       | IN_PROGRESS | None                               | `a09a4b28-fa3e-48de-9dc7-54e485dab9db` | Lane B                 |
| V06-4  | Agent Autopilot Tool - MCP API, policy integration, workflow tests    | TODO        | V06-3                              | `5c7c18c9-d4f5-4402-a3e7-175c8b157cdc` | Lane B                 |
| V06-5  | Continuous Team Memory Core - sync model and import/export flow       | IN_PROGRESS | None                               | `b54417c0-3e60-4f14-9740-7286d9b661f3` | Lane C                 |
| V06-6  | Continuous Team Memory CI - workflows and operational docs            | TODO        | V06-5                              | `afd1b64a-f4b4-4339-8ac5-63156ad307b5` | Lane C                 |
| V06-7  | Benchmark Guardrails Core - benchmark:ci and threshold evaluator      | IN_PROGRESS | None                               | `a3665e33-9e9f-46c8-bd04-7c079b7d6b45` | Lane D                 |
| V06-8  | Benchmark Guardrails CI Gate - baseline management and fail policy    | TODO        | V06-7                              | `f8860f58-db2c-4a5b-b797-8629f3d0ee67` | Lane D                 |
| V06-9  | Adapter Plugin SDK Core - public contract and runtime loader          | IN_PROGRESS | None                               | `ac60c280-57ed-4b20-9395-a77747851c63` | Lane E                 |
| V06-10 | Adapter Plugin SDK Docs - sample plugin, templates, integration tests | TODO        | V06-9                              | `6fe31e96-dcfa-49b0-af68-965ec930a45d` | Lane E                 |
| V06-11 | v0.6 Integration and Release Hardening                                | TODO        | V06-2, V06-4, V06-6, V06-8, V06-10 | `ac8dc315-c3db-47d2-ab15-12de3d861a6a` | Lane F                 |

## Concurrency Plan

## Wave 1 (safe to run in parallel immediately)

1. V06-1 (Lane A)
2. V06-3 (Lane B)
3. V06-5 (Lane C)
4. V06-7 (Lane D)
5. V06-9 (Lane E)

## Wave 2 (parallel after each Wave 1 dependency finishes)

1. V06-2 after V06-1
2. V06-4 after V06-3
3. V06-6 after V06-5
4. V06-8 after V06-7
5. V06-10 after V06-9

## Wave 3 (final integration)

1. V06-11 after V06-2, V06-4, V06-6, V06-8, V06-10

## Dependency Graph

```text
V06-1 -> V06-2 -----\
V06-3 -> V06-4 ------\
V06-5 -> V06-6 -------+-> V06-11
V06-7 -> V06-8 ------/
V06-9 -> V06-10 ----/
```

## Merge Conflict Hotspots and Mitigation

1. `src/mcp/tools/index.ts`
   Action: reserve short merge windows and rebase before merge.

2. `src/mcp/tools/*.ts` shared request/response types
   Action: land shared schema changes first, then feature branches consume.

3. `.github/workflows/ci.yml`
   Action: single owner for CI edits (Lane C + Lane D integration checkpoint).

4. `src/config/constants.ts` and config schema files
   Action: append-only config changes with named v0.6 blocks.

## Agent Execution Rules

1. Before taking a task, mark it `IN_PROGRESS` here and in Vibe Kanban.
2. One primary owner per task; other agents contribute only via linked subtasks/PRs.
3. Keep changes scoped to one lane unless task explicitly requires cross-lane integration.
4. When done, set status to `DONE`, link commits/PRs, and note residual risks.

## Progress Log

| Timestamp  | Agent    | Action                   | Notes                                                                        |
| ---------- | -------- | ------------------------ | ---------------------------------------------------------------------------- |
| 2026-02-08 | OpenCode | Started Wave 1 execution | Launched 5 parallel workspace sessions for V06-1, V06-3, V06-5, V06-7, V06-9 |

## Definition of Done for v0.6

1. All tasks V06-1 through V06-11 are `DONE` in both this file and Vibe Kanban.
2. Milestone acceptance criteria in `devdocs/SDL-MCP_v0.6.md` are satisfied.
3. `npm test`, harness tests, and benchmark CI gate pass.
4. Release notes and migration documentation are updated.
