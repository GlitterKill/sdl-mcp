# Provider-First LSP PHP Validation - 2026-06-16

This validation uses `sebastianbergmann/phpunit` as the PHP Wave 0 repository. It proves the SDL-MCP LSP provider-first execution path can run against a real PHP repo with LSP-IO-managed phpactor configuration, materialize LSP-owned graph rows, mix legacy fallback for files outside the provider cap, activate the shadow graph, pass the provider-first graph gate, and serve the normal symbol/slice/source-window smoke ladder.

Repository:

`F:\Claude\projects\sdl-lsp-provider-first-repos\phpunit`

Graph database:

`F:\Claude\projects\sdl-lsp-provider-first-repos\phpunit\.tmp\sdl-provider-first-lsp-php-full-capped.lbug`

## LSP-IO Setup

`lsp-io` is the server authority. The phpactor server entry is exported through:

```powershell
cargo run --manifest-path F:\Claude\projects\lsp-io\Cargo.toml -p lsp-io-cli -- export sdl-mcp F:\Claude\projects\sdl-lsp-provider-first-repos\phpunit --include-missing --output F:\Claude\projects\sdl-lsp-provider-first-repos\phpunit\sdl-lsp-export.json
```

Relevant exported command:

```text
command: C:/Users/glitt/AppData/Local/lsp-io/servers/phpactor/manual/php-8.4.22-nts-Win32-vs17-x64/php.exe
args: C:/Users/glitt/AppData/Local/lsp-io/servers/phpactor/manual/phpactor.phar language-server --quiet
readiness: manual
```

The PHP runtime and phpactor PHAR are installed under the lsp-io server cache because phpactor does not ship as an npm-style Windows shim. The phpactor status check reports `Phpactor 2026.05.30.2`.

## Provider-First Index

The full-repo validation uses `documentSymbolFileLimit=50` to keep phpactor document-symbol collection bounded while still proving full repository orchestration, same-run fallback, and shadow activation.

Command:

```powershell
$env:SDL_GRAPH_DB_PATH='F:\Claude\projects\sdl-lsp-provider-first-repos\phpunit\.tmp\sdl-provider-first-lsp-php-full-capped.lbug'
node dist\cli\index.js -c F:\Claude\projects\sdl-lsp-provider-first-repos\phpunit\sdlmcp.php.full-capped.config.json index --repo-id phpunit-php --force
```

Relevant result:

```text
Provider-first: lspFull (provider-first-lsp:1781626448620)
Provider-first timings: total=221643ms; slowest=collect 103844ms
Provider-first shadow DB finalized: files=2574 symbols=14583 edges=135752 versions=1 metrics=14583 fileSummaries=2574 auxiliarySymbols=3939 copy=bulkCsv artifacts=20
Provider-first shadow DB activated: F:/Claude/projects/sdl-lsp-provider-first-repos/phpunit/.tmp/sdl-provider-first-lsp-php-full-capped.lbug
Provider-first coverage: 50/2574 files provider-primary (0 full, 50 partial); 2524 uncovered; legacy fallback parsed 2524 file(s)
Files: 2574
Symbols: 14679 new (14583 total)
Edges: 141390 new (135752 total)
Wall time: 221669ms
```

Provider-primary PHP rows are partial because this wave materializes document symbols and diagnostics, not references/call proof. Same-run legacy fallback covers files outside the provider cap.

## Graph Check

Command:

```powershell
npm run check:provider-first-graph -- --db F:\Claude\projects\sdl-lsp-provider-first-repos\phpunit\.tmp\sdl-provider-first-lsp-php-full-capped.lbug --repo-root F:\Claude\projects\sdl-lsp-provider-first-repos\phpunit
```

Result:

```text
PASS provider-first graph check: 0/5 gate(s) failed
```

## Smoke Queries

`symbol.search` for `Assert` returned the full graph symbol:

```text
3ba8749577c2dcca675c96c143fb0426a79045035f6d19536dad4e91b88970b6
src/Framework/Assert.php
PHPUnit\Framework\Assert
```

`symbol.getCard` returned the PHP class card:

```text
file: src/Framework/Assert.php
range: L75-L3332
kind: class
name: PHPUnit\Framework\Assert
```

`slice.build` succeeded:

```text
sliceHandle: 3c34ba505caddedaa9615ae005ca30e2
ledgerVersion: v1781626646807
```

`code.getHotPath` returned the expected excerpt around `abstract class Assert`.

`code.needWindow` succeeded:

```text
approved: true
file: src/Framework/Assert.php
range: L1567-L1586
whyApproved: Identifiers matched: Assert
```

## Outcome

PHP is marked validated for Wave 0 provider-first LSP document-symbol materialization with capped provider coverage. Remaining quality work should collect definitions/references from phpactor and tune collection throughput before increasing the provider cap substantially.
