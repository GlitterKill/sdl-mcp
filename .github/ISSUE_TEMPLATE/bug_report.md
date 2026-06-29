---
name: Bug report
about: Create a report to help us improve
title: ''
labels: bug
assignees: GlitterKill

---

**Describe the bug**
A clear and concise description of what the bug is.


**Platform (please complete the following information):**
 - OS: [e.g. iOS]
 - CPU: [e.g. x64]
 - SDL Version: [e.g. 0.11.12]
 - Node Version: [e.g. 24.16.0]

**Additional context**
Add any other context about the problem here.


**SDL Config (not including repos) changed defaults - https://github.com/GlitterKill/sdl-mcp/blob/main/docs/configuration-reference.md**

  "semantic": {
    "enabled": true,
    "provider": "local",
    "onnx": {
      "intraOpNumThreads": 4,
      "interOpNumThreads": 1,
      "executionMode": "parallel"
    },
    "executionProviders": [
      "dml",
      "cpu"
    ],
    "embeddingProfile": "specialized",
    "embeddingConcurrency": 4,
    "embeddingBatchSize": 32,
      },
  "scip": {
    "enabled": true,
    "indexes": [
      {
        "path": "index.scip"
      }
    ],
    "externalSymbols": {
      "enabled": true,
      "maxPerIndex": 10000
    },
    "confidence": 0.95,
    "autoIngestOnRefresh": true,
    "generator": {
      "enabled": true,
      "binary": "scip-io",
      "args": [
        "--include-additional-configs",
        "--timeout",
        "3600"
      ],
      "autoInstall": true,
      "timeoutMs": 18000000
    }
  },
