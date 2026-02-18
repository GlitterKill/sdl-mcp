const vscode = require("vscode");

let statusBarItem;
let diagnosticsChannel;
let reindexTimer = null;
let reindexInFlight = false;

function getConfig() {
  const cfg = vscode.workspace.getConfiguration("sdl");
  return {
    serverUrl: cfg.get("serverUrl", "http://localhost:3000").replace(/\/+$/, ""),
    repoId: cfg.get("repoId", "sdl-mcp"),
    autoConnect: cfg.get("autoConnect", true),
    enableCodeLens: cfg.get("enableCodeLens", true),
    enableOnSaveReindex: cfg.get("enableOnSaveReindex", false),
  };
}

async function requestJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json();
}

async function loadRepoStatus() {
  const cfg = getConfig();
  return requestJson(`${cfg.serverUrl}/api/repo/${encodeURIComponent(cfg.repoId)}/status`);
}

async function updateStatusBar() {
  const cfg = getConfig();
  if (!cfg.autoConnect) {
    statusBarItem.text = "$(circle-slash) SDL: disabled";
    statusBarItem.tooltip = "SDL MCP auto-connect disabled.";
    return;
  }

  try {
    const status = await loadRepoStatus();
    statusBarItem.text = reindexInFlight
      ? "$(sync~spin) SDL indexing"
      : `$(graph) SDL ${status.symbolCount ?? 0} syms`;
    statusBarItem.tooltip = `Repo ${status.repoId}\\nLatest: ${status.latestVersionId ?? "n/a"}\\nFiles: ${status.fileCount ?? 0}`;
  } catch (error) {
    statusBarItem.text = "$(warning) SDL offline";
    statusBarItem.tooltip = `SDL server not found. ${String(error)}`;
  }
}

async function lookupSymbol(word) {
  if (!word) return null;
  const cfg = getConfig();
  const data = await requestJson(
    `${cfg.serverUrl}/api/symbol/${encodeURIComponent(cfg.repoId)}/search?q=${encodeURIComponent(word)}&limit=1`,
  );
  return data.results && data.results.length > 0 ? data.results[0] : null;
}

function buildCodeLensProvider() {
  return {
    async provideCodeLenses(document) {
      const cfg = getConfig();
      if (!cfg.enableCodeLens) {
        return [];
      }
      const text = document.getText();
      const regex = /\b(function|class)\s+([A-Za-z_][A-Za-z0-9_]*)/g;
      const lenses = [];
      let match;

      while ((match = regex.exec(text)) !== null) {
        const name = match[2];
        const pos = document.positionAt(match.index);
        try {
          const symbol = await lookupSymbol(name);
          if (!symbol) continue;
          const card = await requestJson(
            `${cfg.serverUrl}/api/symbol/${encodeURIComponent(cfg.repoId)}/card/${encodeURIComponent(symbol.symbolId)}`,
          );
          lenses.push(
            new vscode.CodeLens(new vscode.Range(pos, pos), {
              title: `SDL fan-in ${card.fanIn ?? 0} fan-out ${card.fanOut ?? 0}`,
              command: "sdl.showDiagnostics",
            }),
          );
        } catch {
          // Skip missing symbols.
        }
      }

      return lenses;
    },
  };
}

function buildHoverProvider() {
  return {
    async provideHover(document, position) {
      const range = document.getWordRangeAtPosition(position);
      if (!range) return null;
      const word = document.getText(range);
      if (!word) return null;
      try {
        const symbol = await lookupSymbol(word);
        if (!symbol) return null;
        const cfg = getConfig();
        const card = await requestJson(
          `${cfg.serverUrl}/api/symbol/${encodeURIComponent(cfg.repoId)}/card/${encodeURIComponent(symbol.symbolId)}`,
        );
        const summary = card.summary || "No summary available.";
        return new vscode.Hover(`**${card.name}** (${card.kind})\\n\\n${summary}`);
      } catch {
        return null;
      }
    },
  };
}

function scheduleOnSaveReindex() {
  if (reindexTimer) {
    clearTimeout(reindexTimer);
  }
  reindexTimer = setTimeout(async () => {
    if (reindexInFlight) {
      return;
    }
    const cfg = getConfig();
    try {
      reindexInFlight = true;
      await updateStatusBar();
      await requestJson(
        `${cfg.serverUrl}/api/repo/${encodeURIComponent(cfg.repoId)}/reindex`,
        { method: "POST" },
      );
    } catch {
      // Ignore transient failures.
    } finally {
      reindexInFlight = false;
      await updateStatusBar();
    }
  }, 500);
}

function registerCommands(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand("sdl.showBlastRadius", async () => {
      const cfg = getConfig();
      const fromVersion = await vscode.window.showInputBox({
        prompt: "From version id",
      });
      const toVersion = await vscode.window.showInputBox({
        prompt: "To version id",
      });
      if (!fromVersion || !toVersion) return;
      const url = `${cfg.serverUrl}/ui/graph?repoId=${encodeURIComponent(cfg.repoId)}&fromVersion=${encodeURIComponent(fromVersion)}&toVersion=${encodeURIComponent(toVersion)}`;
      await vscode.env.openExternal(vscode.Uri.parse(url));
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("sdl.refreshIndex", async () => {
      if (reindexInFlight) {
        return;
      }
      const cfg = getConfig();
      reindexInFlight = true;
      await updateStatusBar();
      try {
        await requestJson(
          `${cfg.serverUrl}/api/repo/${encodeURIComponent(cfg.repoId)}/reindex`,
          { method: "POST" },
        );
        vscode.window.showInformationMessage(
          "SDL incremental index refresh requested.",
        );
      } finally {
        reindexInFlight = false;
        await updateStatusBar();
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("sdl.showDiagnostics", async () => {
      diagnosticsChannel.show(true);
      diagnosticsChannel.clear();
      const cfg = getConfig();
      diagnosticsChannel.appendLine(`SDL Server: ${cfg.serverUrl}`);
      diagnosticsChannel.appendLine(`Repo ID: ${cfg.repoId}`);
      try {
        const status = await loadRepoStatus();
        diagnosticsChannel.appendLine(`Connected: yes`);
        diagnosticsChannel.appendLine(`Latest version: ${status.latestVersionId ?? "n/a"}`);
        diagnosticsChannel.appendLine(`Files: ${status.fileCount ?? 0}`);
        diagnosticsChannel.appendLine(`Symbols: ${status.symbolCount ?? 0}`);
      } catch (error) {
        diagnosticsChannel.appendLine(`Connected: no`);
        diagnosticsChannel.appendLine(`Error: ${String(error)}`);
      }
    }),
  );
}

function activate(context) {
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.command = "sdl.showDiagnostics";
  statusBarItem.show();
  diagnosticsChannel = vscode.window.createOutputChannel("SDL MCP");
  context.subscriptions.push(statusBarItem, diagnosticsChannel);

  registerCommands(context);

  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(
      [{ language: "typescript" }, { language: "javascript" }, { language: "python" }],
      buildCodeLensProvider(),
    ),
  );

  context.subscriptions.push(
    vscode.languages.registerHoverProvider(
      [{ language: "typescript" }, { language: "javascript" }, { language: "python" }],
      buildHoverProvider(),
    ),
  );

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(() => {
      const cfg = getConfig();
      if (!cfg.enableOnSaveReindex) return;
      scheduleOnSaveReindex();
    }),
  );

  const interval = setInterval(() => {
    void updateStatusBar();
  }, 30000);
  context.subscriptions.push({ dispose: () => clearInterval(interval) });

  void updateStatusBar();
}

function deactivate() {}

module.exports = { activate, deactivate };
