# src/live-index/ - Real-Time Draft Indexing

## OVERVIEW
Tracks unsaved editor buffers, parses drafts into an in-memory overlay, and reconciles with the persisted index. Enables MCP tools to see code-in-progress.

## KEY FILES

| File | Purpose |
|------|---------|
| `coordinator.ts` | `InMemoryLiveIndexCoordinator` - main orchestrator |
| `overlay-store.ts` | In-memory overlay of draft symbols |
| `overlay-merge.ts` | Merge overlay with persisted index |
| `overlay-reader.ts` | Read from overlay |
| `draft-parser.ts` | Parse unsaved buffer content via tree-sitter |
| `reconcile-queue.ts` | Background reconciliation queue |
| `reconcile-worker.ts` | Worker that reconciles draft to persisted |
| `reconcile-planner.ts` | Plans reconciliation strategy |
| `checkpoint-service.ts` | Checkpoint draft state to DB |
| `idle-monitor.ts` | Auto-checkpoint on idle |
| `debounce.ts` | Debounced job scheduler |
| `dependency-frontier.ts` | Dependency frontier tracking |
| `file-patcher.ts` | Apply file patches to overlay |

## EVENT TYPES
`open`, `change`, `save`, `close`, `checkpoint`

## CONVENTIONS
- Buffer events are debounced before triggering parse
- Overlay is purely in-memory (never persisted until checkpoint)
- Reconciliation runs in background, does not block tool responses
- Coordinator is the single entry point for all buffer operations
