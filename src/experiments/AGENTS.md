# src/experiments/ - Offline Testing Utilities

## OVERVIEW
Experimental and offline testing utilities that are not directly imported by the main application.
These modules are used for offline replay, debugging, and benchmarking — not dead code.

## FILES

- `event-log-replay.ts` - Event log replay utility for offline testing of the indexer and MCP tool pipeline. Used to replay recorded event sequences for regression testing and performance analysis. **Not imported by `src/` at runtime — this is intentional.** Invoked via scripts or test harnesses.

## NOTE FOR REVIEWERS
Files in this directory may appear as unused exports in static analysis tools. They are offline testing utilities consumed outside the normal import graph.
