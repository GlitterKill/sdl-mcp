# @sdl-mcp/ladybug-openssl-win32-x64

Temporary SDL-MCP-owned OpenSSL runtime for LadybugDB 0.18.1 FTS on Windows x64.

This package is data-only. It intentionally has no JavaScript entry point. SDL-MCP resolves the exported metadata, verifies provenance hashes, and loads the DLLs by explicit package paths while LadybugDB's Windows FTS extension depends on OpenSSL 3.

Contents:

- bin/libcrypto-3-x64.dll
- bin/libssl-3-x64.dll
- OPENSSL-LICENSE.txt
- provenance.json
- sbom.spdx.json

Do not add Git, Conda, or system OpenSSL directories to PATH to fix FTS loading. The SDL native loader must report both loaded module origins inside this package's bin directory.

Remove this package when LadybugDB distributes or loads its required Windows OpenSSL runtime itself and the no-SDL-runtime compatibility probe passes.
