# file.write Tool Reference

<div align="right">
<details>
<summary><strong>Docs Navigation</strong></summary>

- [Overview](../README.md)
- [Documentation Hub](./README.md)
  - [Getting Started](./getting-started.md)
  - [MCP Tools Reference](./mcp-tools-reference.md)
  - [file.read Tool](./file-read-tool.md)
  - [file.write Tool (this page)](./file-write-tool.md)
  - [Configuration Reference](./configuration-reference.md)

</details>
</div>

The `file.write` tool provides token-efficient file writing with six targeted write modes. Instead of sending entire file contents, you can make surgical changes using line replacement, pattern replacement, JSON path updates, insertions, or appends.

---

## Overview

```mermaid
%%{init: {"theme":"base","themeVariables":{"background":"#ffffff","primaryColor":"#E7F8F2","primaryBorderColor":"#0F766E","primaryTextColor":"#102A43","secondaryColor":"#E8F1FF","secondaryBorderColor":"#2563EB","secondaryTextColor":"#102A43","tertiaryColor":"#FFF4D6","tertiaryBorderColor":"#B45309","tertiaryTextColor":"#102A43","lineColor":"#0F766E","textColor":"#102A43","fontFamily":"Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"},"flowchart":{"curve":"basis","htmlLabels":true}}}%%
flowchart TD
    A[file.write request] e1@--> B{Write mode?}

    B e2@-->|content| C[Full Write/Create]
    B e3@-->|replaceLines| D[Line Range Replace]
    B e4@-->|replacePattern| E[Regex Find/Replace]
    B e5@-->|jsonPath + jsonValue| F[JSON Path Update]
    B e6@-->|insertAt| G[Insert at Line]
    B e7@-->|append| H[Append to End]

    C e8@--> I[Overwrite entire file]
    D e9@--> J[Replace lines start:end]
    E e10@--> K[Pattern substitution]
    F e11@--> L[Update specific JSON key]
    G e12@--> M[Insert without overwriting]
    H e13@--> N[Add to end of file]

    I e14@--> O{createBackup?}
    J e15@--> O
    K e16@--> O
    L e17@--> O
    G e18@--> O
    H e19@--> O

    O e20@-->|Yes| P[Create .bak file]
    O e21@-->|No| Q[Write directly]
    P e22@--> R[Write changes]
    Q e23@--> R

    classDef source fill:#E7F8F2,stroke:#0F766E,stroke-width:2px,color:#102A43;
    classDef process fill:#E8F1FF,stroke:#2563EB,stroke-width:2px,color:#102A43;
    classDef decision fill:#FFF4D6,stroke:#B45309,stroke-width:2px,color:#102A43;
    classDef storage fill:#F2E8FF,stroke:#7C3AED,stroke-width:2px,color:#102A43;
    classDef output fill:#FFE8EF,stroke:#BE123C,stroke-width:2px,color:#102A43;
    classDef muted fill:#F8FAFC,stroke:#64748B,stroke-width:1px,color:#102A43;
    classDef animate stroke:#0F766E,stroke-width:2px,stroke-dasharray:10\,5,stroke-dashoffset:900,animation:dash 22s linear infinite;
    class e1,e2,e3,e4,e5,e6,e7,e8,e9,e10,e11,e12,e13,e14,e15,e16,e17,e18,e19,e20,e21,e22,e23 animate;
```

---

## Parameters

| Parameter         | Type    | Required | Default | Description                                       |
| ----------------- | ------- | -------- | ------- | ------------------------------------------------- |
| `repoId`          | string  | Yes      | -       | Repository identifier                             |
| `filePath`        | string  | Yes      | -       | File path relative to repo root                   |
| `content`         | string  | No       | -       | Full file content (create/overwrite mode)         |
| `replaceLines`    | object  | No       | -       | Line range replacement                            |
| `replacePattern`  | object  | No       | -       | Regex find/replace                                |
| `jsonPath`        | string  | No       | -       | Dot-separated path to update in JSON              |
| `jsonValue`       | any     | No       | -       | New value for jsonPath (required if jsonPath set) |
| `insertAt`        | object  | No       | -       | Insert content at line                            |
| `append`          | string  | No       | -       | Content to append to end                          |
| `createBackup`    | boolean | No       | `true`  | Create .bak backup before modifying               |
| `createIfMissing` | boolean | No       | `false` | Create file if it doesn't exist                   |

### Mode Parameters

**replaceLines:**

```typescript
{
  start: number,   // Start line (0-based, inclusive)
  end: number,     // End line (0-based, exclusive)
  content: string  // New content for the range
}
```

**replacePattern:**

```typescript
{
  pattern: string,      // Regex pattern to find
  replacement: string,  // Replacement (supports capture groups)
  global?: boolean      // Replace all occurrences (default: false)
}
```

**insertAt:**

```typescript
{
  line: number,    // Line number to insert at (0-based)
  content: string  // Content to insert
}
```

---

## Response

| Field              | Type   | Description                                  |
| ------------------ | ------ | -------------------------------------------- |
| `filePath`         | string | Normalized file path                         |
| `bytesWritten`     | number | Bytes written to file                        |
| `linesWritten`     | number | Lines in written content                     |
| `mode`             | string | Write mode used                              |
| `backupPath`       | string | Path to backup file (if created)             |
| `replacementCount` | number | Number of replacements (replacePattern mode) |

---

## Write Modes

### Mode 1: Full Content

Create a new file or overwrite existing content entirely.

```mermaid
%%{init: {"theme":"base","themeVariables":{"background":"#ffffff","primaryColor":"#E7F8F2","primaryBorderColor":"#0F766E","primaryTextColor":"#102A43","secondaryColor":"#E8F1FF","secondaryBorderColor":"#2563EB","secondaryTextColor":"#102A43","tertiaryColor":"#FFF4D6","tertiaryBorderColor":"#B45309","tertiaryTextColor":"#102A43","lineColor":"#0F766E","textColor":"#102A43","fontFamily":"Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"},"flowchart":{"curve":"basis","htmlLabels":true}}}%%
flowchart LR
    subgraph Input
        A["content: 'new file content'"]
    end
    subgraph File
        B["(empty or existing)"]
    end
    subgraph Output
        C["new file content"]
    end

    A e1@--> B
    B e2@--> C

    classDef source fill:#E7F8F2,stroke:#0F766E,stroke-width:2px,color:#102A43;
    classDef process fill:#E8F1FF,stroke:#2563EB,stroke-width:2px,color:#102A43;
    classDef decision fill:#FFF4D6,stroke:#B45309,stroke-width:2px,color:#102A43;
    classDef storage fill:#F2E8FF,stroke:#7C3AED,stroke-width:2px,color:#102A43;
    classDef output fill:#FFE8EF,stroke:#BE123C,stroke-width:2px,color:#102A43;
    classDef muted fill:#F8FAFC,stroke:#64748B,stroke-width:1px,color:#102A43;
    classDef animate stroke:#0F766E,stroke-width:2px,stroke-dasharray:10\,5,stroke-dashoffset:900,animation:dash 22s linear infinite;
    class e1,e2 animate;
```

**Example:**

```json
{
  "fn": "file.write",
  "args": {
    "filePath": "config/new-config.json",
    "content": "{\n  \"version\": 1\n}",
    "createIfMissing": true
  }
}
```

---

### Mode 2: Replace Lines

Replace a specific line range with new content. Ideal for updating sections of config files.

```mermaid
%%{init: {"theme":"base","themeVariables":{"background":"#ffffff","primaryColor":"#E7F8F2","primaryBorderColor":"#0F766E","primaryTextColor":"#102A43","secondaryColor":"#E8F1FF","secondaryBorderColor":"#2563EB","secondaryTextColor":"#102A43","tertiaryColor":"#FFF4D6","tertiaryBorderColor":"#B45309","tertiaryTextColor":"#102A43","lineColor":"#0F766E","textColor":"#102A43","fontFamily":"Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"},"flowchart":{"curve":"basis","htmlLabels":true}}}%%
flowchart LR
    subgraph Input
        A["replaceLines:\n  start: 5\n  end: 8\n  content: 'new lines'"]
    end
    subgraph "Before"
        B1[Lines 1-4]
        B2[Lines 5-7]
        B3[Lines 8+]
    end
    subgraph "After"
        C1[Lines 1-4]
        C2[new lines]
        C3[Lines 8+]
    end

    A e1@--> B2
    B1 e2@--> C1
    B2 e3@--> C2
    B3 e4@--> C3

    style B2 fill:#FFE8EF,stroke:#BE123C,stroke-width:2px,color:#102A43
    style C2 fill:#E7F8F2,stroke:#0F766E,stroke-width:2px,color:#102A43

    classDef source fill:#E7F8F2,stroke:#0F766E,stroke-width:2px,color:#102A43;
    classDef process fill:#E8F1FF,stroke:#2563EB,stroke-width:2px,color:#102A43;
    classDef decision fill:#FFF4D6,stroke:#B45309,stroke-width:2px,color:#102A43;
    classDef storage fill:#F2E8FF,stroke:#7C3AED,stroke-width:2px,color:#102A43;
    classDef output fill:#FFE8EF,stroke:#BE123C,stroke-width:2px,color:#102A43;
    classDef muted fill:#F8FAFC,stroke:#64748B,stroke-width:1px,color:#102A43;
    classDef animate stroke:#0F766E,stroke-width:2px,stroke-dasharray:10\,5,stroke-dashoffset:900,animation:dash 22s linear infinite;
    class e1,e2,e3,e4 animate;
```

**Example:**

```json
{
  "fn": "file.write",
  "args": {
    "filePath": "config/app.yaml",
    "replaceLines": {
      "start": 10,
      "end": 15,
      "content": "server:\n  port: 8080\n  host: localhost"
    }
  }
}
```

**Token Savings:** Only send the new content for the range instead of the entire file.

---

### Mode 3: Replace Pattern

Find and replace text using regex patterns. Supports capture groups.

```mermaid
%%{init: {"theme":"base","themeVariables":{"background":"#ffffff","primaryColor":"#E7F8F2","primaryBorderColor":"#0F766E","primaryTextColor":"#102A43","secondaryColor":"#E8F1FF","secondaryBorderColor":"#2563EB","secondaryTextColor":"#102A43","tertiaryColor":"#FFF4D6","tertiaryBorderColor":"#B45309","tertiaryTextColor":"#102A43","lineColor":"#0F766E","textColor":"#102A43","fontFamily":"Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"},"flowchart":{"curve":"basis","htmlLabels":true}}}%%
flowchart TD
    subgraph Input
        A["replacePattern:\n  pattern: 'v(\\d+)'\n  replacement: 'v$1.1'\n  global: true"]
    end

    subgraph Processing
        B[Scan file content]
        C[Find all matches]
        D[Apply replacements]
    end

    subgraph Output
        E["v1 → v1.1\nv2 → v2.1"]
    end

    A e1@--> B
    B e2@--> C
    C e3@--> D
    D e4@--> E

    classDef source fill:#E7F8F2,stroke:#0F766E,stroke-width:2px,color:#102A43;
    classDef process fill:#E8F1FF,stroke:#2563EB,stroke-width:2px,color:#102A43;
    classDef decision fill:#FFF4D6,stroke:#B45309,stroke-width:2px,color:#102A43;
    classDef storage fill:#F2E8FF,stroke:#7C3AED,stroke-width:2px,color:#102A43;
    classDef output fill:#FFE8EF,stroke:#BE123C,stroke-width:2px,color:#102A43;
    classDef muted fill:#F8FAFC,stroke:#64748B,stroke-width:1px,color:#102A43;
    classDef animate stroke:#0F766E,stroke-width:2px,stroke-dasharray:10\,5,stroke-dashoffset:900,animation:dash 22s linear infinite;
    class e1,e2,e3,e4 animate;
```

**Example:**

```json
{
  "fn": "file.write",
  "args": {
    "filePath": "README.md",
    "replacePattern": {
      "pattern": "version: ([0-9.]+)",
      "replacement": "version: 2.0.0",
      "global": false
    }
  }
}
```

**Safety Features:**

- Pattern length limit: 500 characters
- ReDoS protection: Rejects nested quantifiers

---

### Mode 4: JSON Path Update

Update a specific key in a JSON file without touching other content.

```mermaid
%%{init: {"theme":"base","themeVariables":{"background":"#ffffff","primaryColor":"#E7F8F2","primaryBorderColor":"#0F766E","primaryTextColor":"#102A43","secondaryColor":"#E8F1FF","secondaryBorderColor":"#2563EB","secondaryTextColor":"#102A43","tertiaryColor":"#FFF4D6","tertiaryBorderColor":"#B45309","tertiaryTextColor":"#102A43","lineColor":"#0F766E","textColor":"#102A43","fontFamily":"Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"},"flowchart":{"curve":"basis","htmlLabels":true}}}%%
flowchart LR
    subgraph Input
        A["jsonPath: 'server.port'\njsonValue: 9000"]
    end

    subgraph "config.json"
        B["{\n  server: {\n    port: 8080,\n    host: 'localhost'\n  },\n  database: {...}\n}"]
    end

    subgraph Output
        C["{\n  server: {\n    port: 9000,\n    host: 'localhost'\n  },\n  database: {...}\n}"]
    end

    A e1@--> B
    B e2@--> C

    style B fill:#FFE8EF,stroke:#BE123C,stroke-width:2px,color:#102A43
    style C fill:#E7F8F2,stroke:#0F766E,stroke-width:2px,color:#102A43

    classDef source fill:#E7F8F2,stroke:#0F766E,stroke-width:2px,color:#102A43;
    classDef process fill:#E8F1FF,stroke:#2563EB,stroke-width:2px,color:#102A43;
    classDef decision fill:#FFF4D6,stroke:#B45309,stroke-width:2px,color:#102A43;
    classDef storage fill:#F2E8FF,stroke:#7C3AED,stroke-width:2px,color:#102A43;
    classDef output fill:#FFE8EF,stroke:#BE123C,stroke-width:2px,color:#102A43;
    classDef muted fill:#F8FAFC,stroke:#64748B,stroke-width:1px,color:#102A43;
    classDef animate stroke:#0F766E,stroke-width:2px,stroke-dasharray:10\,5,stroke-dashoffset:900,animation:dash 22s linear infinite;
    class e1,e2 animate;
```

**Example:**

```json
{
  "fn": "file.write",
  "args": {
    "filePath": "package.json",
    "jsonPath": "version",
    "jsonValue": "2.0.0"
  }
}
```

**Path Syntax:**

- Simple key: `"name"`
- Nested key: `"server.port"`
- Array index: `"scripts.0"`
- Deep path: `"dependencies.lodash"`

**Supported Files:** `.json` only

**Token Savings:** Send only the key path and new value (~20-50 tokens) instead of the entire JSON file.

---

### Mode 5: Insert at Line

Insert new content at a specific line without replacing existing content.

```mermaid
%%{init: {"theme":"base","themeVariables":{"background":"#ffffff","primaryColor":"#E7F8F2","primaryBorderColor":"#0F766E","primaryTextColor":"#102A43","secondaryColor":"#E8F1FF","secondaryBorderColor":"#2563EB","secondaryTextColor":"#102A43","tertiaryColor":"#FFF4D6","tertiaryBorderColor":"#B45309","tertiaryTextColor":"#102A43","lineColor":"#0F766E","textColor":"#102A43","fontFamily":"Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"},"flowchart":{"curve":"basis","htmlLabels":true}}}%%
flowchart LR
    subgraph Input
        A["insertAt:\n  line: 5\n  content: '# New Section'"]
    end
    subgraph "Before"
        B1[Lines 1-4]
        B2[Lines 5+]
    end
    subgraph "After"
        C1[Lines 1-4]
        C2["# New Section"]
        C3[Lines 5+]
    end

    A e1@--> B1
    B1 e2@--> C1
    B2 e3@--> C3
    C2 e4@-.-> C3

    style C2 fill:#E7F8F2,stroke:#0F766E,stroke-width:2px,color:#102A43

    classDef source fill:#E7F8F2,stroke:#0F766E,stroke-width:2px,color:#102A43;
    classDef process fill:#E8F1FF,stroke:#2563EB,stroke-width:2px,color:#102A43;
    classDef decision fill:#FFF4D6,stroke:#B45309,stroke-width:2px,color:#102A43;
    classDef storage fill:#F2E8FF,stroke:#7C3AED,stroke-width:2px,color:#102A43;
    classDef output fill:#FFE8EF,stroke:#BE123C,stroke-width:2px,color:#102A43;
    classDef muted fill:#F8FAFC,stroke:#64748B,stroke-width:1px,color:#102A43;
    classDef animate stroke:#0F766E,stroke-width:2px,stroke-dasharray:10\,5,stroke-dashoffset:900,animation:dash 22s linear infinite;
    class e1,e2,e3,e4 animate;
```

**Example:**

```json
{
  "fn": "file.write",
  "args": {
    "filePath": "CHANGELOG.md",
    "insertAt": {
      "line": 2,
      "content": "## [2.0.0] - 2024-01-15\n\n### Added\n- New feature"
    }
  }
}
```

---

### Mode 6: Append

Add content to the end of a file.

```mermaid
%%{init: {"theme":"base","themeVariables":{"background":"#ffffff","primaryColor":"#E7F8F2","primaryBorderColor":"#0F766E","primaryTextColor":"#102A43","secondaryColor":"#E8F1FF","secondaryBorderColor":"#2563EB","secondaryTextColor":"#102A43","tertiaryColor":"#FFF4D6","tertiaryBorderColor":"#B45309","tertiaryTextColor":"#102A43","lineColor":"#0F766E","textColor":"#102A43","fontFamily":"Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"},"flowchart":{"curve":"basis","htmlLabels":true}}}%%
flowchart LR
    subgraph Input
        A["append: 'new entry'"]
    end
    subgraph "Before"
        B[Existing content]
    end
    subgraph "After"
        C[Existing content]
        D[new entry]
    end

    A e1@--> B
    B e2@--> C
    C e3@--> D

    style D fill:#E7F8F2,stroke:#0F766E,stroke-width:2px,color:#102A43

    classDef source fill:#E7F8F2,stroke:#0F766E,stroke-width:2px,color:#102A43;
    classDef process fill:#E8F1FF,stroke:#2563EB,stroke-width:2px,color:#102A43;
    classDef decision fill:#FFF4D6,stroke:#B45309,stroke-width:2px,color:#102A43;
    classDef storage fill:#F2E8FF,stroke:#7C3AED,stroke-width:2px,color:#102A43;
    classDef output fill:#FFE8EF,stroke:#BE123C,stroke-width:2px,color:#102A43;
    classDef muted fill:#F8FAFC,stroke:#64748B,stroke-width:1px,color:#102A43;
    classDef animate stroke:#0F766E,stroke-width:2px,stroke-dasharray:10\,5,stroke-dashoffset:900,animation:dash 22s linear infinite;
    class e1,e2,e3 animate;
```

**Example:**

```json
{
  "fn": "file.write",
  "args": {
    "filePath": "logs/audit.log",
    "append": "2024-01-15T10:30:00Z - User login: admin\n"
  }
}
```

---

## Backup Behavior

By default, `file.write` creates a backup before modifying any existing file:

```mermaid
%%{init: {"theme":"base","themeVariables":{"background":"#ffffff","primaryColor":"#E7F8F2","primaryBorderColor":"#0F766E","primaryTextColor":"#102A43","secondaryColor":"#E8F1FF","secondaryBorderColor":"#2563EB","secondaryTextColor":"#102A43","tertiaryColor":"#FFF4D6","tertiaryBorderColor":"#B45309","tertiaryTextColor":"#102A43","lineColor":"#0F766E","textColor":"#102A43","fontFamily":"Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"},"flowchart":{"curve":"basis","htmlLabels":true}}}%%
flowchart TD
    A[Write request] e1@--> B{File exists?}
    B e2@-->|No| C[Create new file]
    B e3@-->|Yes| D{createBackup?}
    D e4@-->|Yes default| E[Copy to file.bak]
    D e5@-->|No| F[Skip backup]
    E e6@--> G[Apply changes]
    F e7@--> G
    G e8@--> H[Return response]

    classDef source fill:#E7F8F2,stroke:#0F766E,stroke-width:2px,color:#102A43;
    classDef process fill:#E8F1FF,stroke:#2563EB,stroke-width:2px,color:#102A43;
    classDef decision fill:#FFF4D6,stroke:#B45309,stroke-width:2px,color:#102A43;
    classDef storage fill:#F2E8FF,stroke:#7C3AED,stroke-width:2px,color:#102A43;
    classDef output fill:#FFE8EF,stroke:#BE123C,stroke-width:2px,color:#102A43;
    classDef muted fill:#F8FAFC,stroke:#64748B,stroke-width:1px,color:#102A43;
    classDef animate stroke:#0F766E,stroke-width:2px,stroke-dasharray:10\,5,stroke-dashoffset:900,animation:dash 22s linear infinite;
    class e1,e2,e3,e4,e5,e6,e7,e8 animate;
```

The backup path is returned in the response as `backupPath`.

---

## Token Savings Comparison

| Operation           | Without file.write                  | With file.write                     |
| ------------------- | ----------------------------------- | ----------------------------------- |
| Update one JSON key | Send entire file (~500-5000 tokens) | `jsonPath + jsonValue` (~30 tokens) |
| Fix line 45         | Send entire file                    | `replaceLines` (~50 tokens)         |
| Append log entry    | Send entire file                    | `append` (~20 tokens)               |
| Search/replace      | Send entire file                    | `replacePattern` (~40 tokens)       |

---

## Examples

### Update package.json version

```json
{
  "fn": "file.write",
  "args": {
    "filePath": "package.json",
    "jsonPath": "version",
    "jsonValue": "1.2.3"
  }
}
```

### Replace config section

```json
{
  "fn": "file.write",
  "args": {
    "filePath": "config/database.yaml",
    "replaceLines": {
      "start": 10,
      "end": 20,
      "content": "connection:\n  host: db.example.com\n  port: 5432"
    }
  }
}
```

### Add changelog entry

```json
{
  "fn": "file.write",
  "args": {
    "filePath": "CHANGELOG.md",
    "insertAt": {
      "line": 4,
      "content": "\n## [1.2.0] - 2024-01-15\n\n### Fixed\n- Bug in login flow\n"
    }
  }
}
```

### Global find/replace

```json
{
  "fn": "file.write",
  "args": {
    "filePath": "src/config.ts",
    "replacePattern": {
      "pattern": "localhost:3000",
      "replacement": "api.example.com",
      "global": true
    }
  }
}
```

### Create new file

```json
{
  "fn": "file.write",
  "args": {
    "filePath": "config/feature-flags.json",
    "content": "{\n  \"newFeature\": false,\n  \"betaMode\": true\n}",
    "createIfMissing": true,
    "createBackup": false
  }
}
```

---

## Error Handling

| Error                                 | Cause                                             | Solution                                     |
| ------------------------------------- | ------------------------------------------------- | -------------------------------------------- |
| `Repository not found`                | Invalid repoId                                    | Check repo is registered                     |
| `File not found`                      | File doesn't exist and `createIfMissing` is false | Set `createIfMissing: true` or check path    |
| `Path traversal blocked`              | Path escapes repo root                            | Use relative paths only                      |
| `Must specify exactly one write mode` | No mode or multiple modes specified               | Use exactly one: content, replaceLines, etc. |
| `Start line exceeds file length`      | Invalid line number                               | Check file length first with `file.read`     |
| `jsonPath only supports .json files`  | Trying jsonPath on non-JSON                       | Use replacePattern or replaceLines instead   |
| `Invalid regex pattern`               | Bad regex syntax                                  | Fix the pattern                              |
| `Nested quantifiers`                  | ReDoS-prone pattern                               | Simplify regex                               |

---

## Best Practices

1. **Use targeted modes** - Prefer `jsonPath`, `replaceLines`, or `append` over sending full `content`
2. **Keep backups** - Leave `createBackup: true` (default) for safety
3. **Read before write** - Use `file.read` to verify file state before modifications
4. **Atomic updates** - For JSON files, prefer `jsonPath` to avoid formatting changes
5. **Test patterns** - Verify regex patterns work as expected before `global: true`
