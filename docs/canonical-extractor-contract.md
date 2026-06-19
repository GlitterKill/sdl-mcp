# Canonical Extractor Contract

This contract defines parity between the TypeScript tree-sitter extractors and the Rust native Pass-1 extractor. Strict parity is the CI target: a residual difference must be classified as a compatibility fix, a canonical upgrade, or a defer-with-proof item.

## Identity

- `symbolId` stays the graph identity and is derived from repo, path, kind, name, and AST fingerprint.
- `nodeId` is a per-file source-owner identity used inside one extraction result to connect calls to their owning symbol. It is not compared literally across engines.
- Older TS extractors may emit legacy path/name node IDs while Rust emits stable `name:startLine:startCol` IDs. The parity harness resolves both to semantic owner keys: `kind:name@startLine:startCol`.
- If a raw `nodeId` maps to multiple symbols, the harness chooses the containing symbol with the smallest source range. Unresolved owners are reported as `unresolved:<callerNodeId>`.

## Caller Ownership

- `callerNodeId` must identify the owning source symbol for the call expression.
- Function, method, constructor, class, and module owners are preferred over variable symbols when both contain the same call range.
- Variable owners are still valid when a call appears in a top-level initializer and no non-variable owner contains the call.
- Legacy-derived calls that feed LSP candidate resolution must keep `callerNodeId === owning source symbol nodeId`; candidate counts may only drop for explicitly removed duplicate calls.

## Import Externality

- TypeScript-family `node:` builtins preserve the original `node:` specifier and are non-external when the normalized builtin package is known.
- Java imports are external unless the specifier starts with `java.`, `javax.`, or `jdk.`.
- Shell `source` and `.` imports are local dependency edges. Absolute sourced paths are not external.
- Python relative barrel imports preserve the literal relative specifier and may also emit the normalized module specifier used by TS fixtures.

## Calls

- A source call node should produce one logical call unless the language has distinct nested call expressions in the source.
- Duplicate wrapper matches, such as Go `go` or `defer` statements around the same call expression, are compatibility bugs.
- Chained calls are canonical only when each emitted call maps to a distinct source call node.
- Dynamic calls remain dynamic unless the source proves a concrete callee.

## Provider-First Interaction

- Provider-owned SCIP/LSP facts are canonical for files fully covered by provider-first indexing.
- Rust Pass-1 fixes must not alter provider materialization for provider-owned files.
- Complete same-run fallback may use Rust when configured; partial fallback remains TS/tree-sitter so scoped provider-first runs do not activate shadow rows or prune repo-wide external placeholders.
- Relationship row shape, endpoint safety, and LadybugDB 0.16.0 constraints remain governed by the provider-first DB gates.

## Current Migration Categories

Canonical upgrades promoted to TS:

- PHP function, method, and constructor parameters.
- PHP source-proven member and chained calls.
- Go method return signatures and call de-duplication.
- Rust qualified calls such as `std::fs::read_to_string`.
- TSX/JSX expression-container calls.
- Shell single-quoted `source` and `.` imports.

Compatibility fixes promoted to Rust:

- C++ and C# method and constructor identity.
- Python empty signatures and relative barrel import rows.
- Shell alias symbols, sourced-path externality, and non-variable caller ownership preference.
- TypeScript-family `node:` builtin externality.
- Java package-symbol suppression and Java import externality.

Defer-with-proof:

- Strict runtime parity remains blocked on Windows if the native addon cannot be rebuilt. Source-level Rust changes must at least pass `cargo check`; strict parity must be rerun after MSVC Build Tools and the Windows SDK are available.
