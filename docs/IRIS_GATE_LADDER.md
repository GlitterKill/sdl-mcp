# Iris Gate Ladder

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
- [Iris Gate Ladder (this page)](./IRIS_GATE_LADDER.md)
- [Legacy User Guide](./USER_GUIDE.md)

</details>
</div>

The **Iris Gate Ladder** is SDL-MCP's core methodology for token-efficient context retrieval. It defines a multi-rung escalation path that allows AI agents to understand and modify code while minimizing token consumption.

## The 4 Rungs of Escalation

The ladder follows a "surgical access" philosophy: start with the smallest metadata and only request raw source lines when higher rungs leave ambiguity.

| Rung | Tool | Content Provided | Est. Tokens | Typical Use Case |
| :--- | :--- | :--- | :--- | :--- |
| **1. Symbol Cards** | `sdl.symbol.getCard` | Name, signature, summary, metrics, dependency edges. | ~50 - 150 | Discovering what a symbol does and what it depends on. |
| **2. Skeleton IR** | `sdl.code.getSkeleton` | Full signatures, control flow structures (if/for/try), bodies elided. | ~200 - 400 | Understanding the logical flow and "shape" of a file or class. |
| **3. Hot-Path Excerpt** | `sdl.code.getHotPath` | Targeted lines matching specific identifiers + surrounding context. | ~400 - 800 | Verifying how specific variables or methods are used without reading the whole file. |
| **4. Raw Code Window** | `sdl.code.needWindow` | Complete source code for a specific line range. | ~1,000 - 4,000 | Implementing logic changes or diagnosing deep implementation bugs. |

---

## Rung 1: Symbol Cards
Symbol cards are the atoms of SDL-MCP. They represent the "who, what, and where" of a code element.
- **Includes:** Export status, visibility, language, line ranges, and a semantic summary.
- **Dependency Graph:** Every card knows its `calls` and `imports`, including confidence scores from the pass-2 resolver.
- **Versioning:** Cards are content-addressed; if the code hasn't changed, the card ID remains stable.

## Rung 2: Skeleton IR
Skeletons provide the "Table of Contents" and "Outline" for a file.
- **Control Flow:** Unlike a simple list of signatures, skeletons include the structure of the logic (branches and loops) while replacing implementation blocks with `/* ... */`.
- **Export Filtering:** Agents can request `exportedOnly: true` to further reduce noise in large library files.

## Rung 3: Hot-Path Excerpts
When an agent knows exactly what it's looking for (e.g., "Where is `this.cache` initialized?"), Hot-Pathing is the most efficient choice.
- **Identifier Focus:** The agent provides a list of `identifiersToFind`.
- **Contextual Windows:** SDL-MCP finds every occurrence and returns a small window of lines around it, skipping irrelevant implementation details in between.

## Rung 4: Raw Code Window (The "Gate")
Reading full source code is the most expensive operation and is treated as a "privileged" action.
- **Policy Gating:** Access is controlled by a policy that can require justification, identifier hints, and strict line/token limits.
- **Proof-of-Need:** Agents must explain *why* they need the full code, which prevents lazy "read everything" patterns that exhaust context windows.

---

## Why "Iris Gate"?
The name "Iris" refers to the focused, adjustable aperture used to control the flow of light. Similarly, the Iris Gate Ladder allows the agent to adjust its context "aperture" from a wide-angle overview (Rung 1) to a microscopic deep-dive (Rung 4), always aiming for the optimal balance of signal vs. noise.
