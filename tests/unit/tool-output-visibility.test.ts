import { describe, it } from "node:test";
import assert from "node:assert";

import {
  buildToolResponseContentBlocks,
  buildToolResponseEnvelope,
} from "../../dist/server.js";
import { formatToolCallForUser } from "../../dist/mcp/tool-call-formatter.js";

describe("visible tool output", () => {
  it("returns user display and savings meter as visible MCP content blocks", () => {
    const footer = "📊 100 / 1.0k tokens (SDL/raw-equiv) █░░░░░░░░░ 90%";
    const userDisplay = "search.edit preview -> 2 matches in 1 file";

    const blocks = buildToolResponseContentBlocks(
      { ok: true, _displayFooter: footer },
      userDisplay,
      footer,
    );

    assert.equal(blocks.length, 3);
    assert.match(blocks[0].text, /"ok": true/);
    assert.equal(blocks[1].text, userDisplay);
    assert.equal(blocks[2].text, footer);
  });

  it("keeps response-level display footer while preserving JSON-first content", () => {
    const footer = "usage.stats summary";
    const envelope = buildToolResponseEnvelope({ ok: true }, null, footer);

    assert.equal(envelope._displayFooter, footer);
    assert.equal(envelope.content.length, 2);
    assert.match(envelope.content[0].text, /"ok": true/);
    assert.equal(envelope.content[1].text, footer);
  });

  it("formats sdl.file edit previews with a visible diff preview", () => {
    const display = formatToolCallForUser(
      "sdl.file",
      { op: "searchEditPreview" },
      {
        mode: "preview",
        planHandle: "se-test",
        filesMatched: 1,
        matchesFound: 2,
        fileEntries: [
          {
            file: "src/server.ts",
            matchCount: 2,
            editMode: "replacePattern",
            snippets: {
              before: "  1 | oldValue",
              after: "  1 | newValue",
            },
          },
        ],
      },
    );

    assert.ok(display);
    assert.match(display, /search\.edit preview -> 2 matches in 1 file/);
    assert.match(display, /src\/server\.ts/);
    assert.match(display, /--- before/);
    assert.match(display, /\+\+\+ after/);
    assert.match(display, /oldValue/);
    assert.match(display, /newValue/);
  });
});
