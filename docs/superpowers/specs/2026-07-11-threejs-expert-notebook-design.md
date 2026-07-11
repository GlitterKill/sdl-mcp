# Three.js Expert Markdown Notebook Design

## Goal

Replace the Three.js expert's Claude-managed memory with a private, harness-neutral Markdown notebook stored beside the user-wide agent files.

## Layout

Keep the existing agent prompt at `C:\Users\glitt\.claude\agents\threejs-expert.md`. Store its notebook in the sibling directory with the same base name:

```text
C:\Users\glitt\.claude\agents\
├── threejs-expert.md
└── threejs-expert\
    ├── NOTEBOOK.md
    └── notes\
        ├── decisions.md
        ├── experiments.md
        ├── patterns.md
        ├── failures.md
        ├── resources.md
        └── bugs.md
```

The files remain user-private. Other harnesses may load the same prompt and resolve the notebook relative to it; no Claude memory API or repository notebook is required.

## Protocol

At the start of relevant work, the agent reads `NOTEBOOK.md`, selects only the matching typed note files, and uses current evidence to revalidate drift-prone findings. At the end of substantive work, it updates an existing entry or appends one durable, evidence-backed entry to the appropriate type. It then updates the concise index only when discoverability changes.

The index contains short topic pointers, not duplicated note content. Notes use dated headings and compact fields appropriate to their type. Bug entries retain status, versions/environment, reproduction, expected and actual behavior, evidence, impact, workaround, suspected boundary, and source links. Resource entries include purpose, applicable version, source, and last verification date. Experiments and failures record enough method and evidence to avoid repeating unsuccessful work.

Entries distinguish observation, inference, and hypothesis. They supersede stale or duplicate entries instead of accumulating contradictory copies.

## Privacy and failure handling

Do not store secrets, credentials, personal data, proprietary source or payloads, repository identifiers, machine-specific project paths, or project-specific evidence unless the user explicitly authorizes it. Abstract reusable lessons and revalidate them before applying them elsewhere.

If the notebook is absent, initialize only the approved files. If it is unreadable or unwritable, continue the task, report the affected path and unsaved note, and do not fall back to Claude memory, SDL memory, or repository files.

## Agent changes

Remove `memory: user` from frontmatter. Replace references to Claude memory with the sibling-notebook protocol. Preserve the existing Three.js skill loading, current-documentation research, cage-graph, SDL-MCP interoperability, privacy, and verification requirements.

## Validation

Verify that the frontmatter parses without `memory`, every referenced notebook file exists, the agent contains no instruction to use Claude-managed memory, and notebook links resolve from the agent directory. Run the existing agent validator if available, plus a focused text check of the notebook contract.
