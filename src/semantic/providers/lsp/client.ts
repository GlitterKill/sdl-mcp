import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { win32 } from "node:path";
import { pathToFileURL } from "node:url";

import {
  createMessageConnection,
  NullLogger,
  NotificationType,
  RequestType,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from "vscode-jsonrpc/node.js";
import { SymbolKind } from "vscode-languageserver-protocol";
import type {
  DefinitionParams,
  Diagnostic,
  DidChangeTextDocumentParams,
  DocumentSymbol,
  DocumentSymbolParams,
  DocumentDiagnosticParams,
  DocumentDiagnosticReport,
  DidOpenTextDocumentParams,
  Hover,
  InitializeParams,
  InitializeResult,
  Location,
  LocationLink,
  PublishDiagnosticsParams,
  ReferenceParams,
  SymbolInformation,
  TextDocumentContentChangeEvent,
  TextDocumentItem,
  VersionedTextDocumentIdentifier,
} from "vscode-languageserver-protocol";

const InitializeRequest = new RequestType<
  InitializeParams,
  InitializeResult,
  void
>("initialize");
const ShutdownRequest = new RequestType<void, void, void>("shutdown");
const InitializedNotification = new NotificationType<object>("initialized");
const ExitNotification = new NotificationType<void>("exit");
const DidOpenTextDocumentNotification =
  new NotificationType<DidOpenTextDocumentParams>("textDocument/didOpen");
const DidChangeTextDocumentNotification =
  new NotificationType<DidChangeTextDocumentParams>("textDocument/didChange");
const PublishDiagnosticsNotification =
  new NotificationType<PublishDiagnosticsParams>(
    "textDocument/publishDiagnostics",
  );
const DefinitionRequest = new RequestType<
  DefinitionParams,
  Location | Location[] | LocationLink[] | null,
  void
>("textDocument/definition");
const ReferencesRequest = new RequestType<
  ReferenceParams,
  Location[] | null,
  void
>("textDocument/references");
const DocumentSymbolRequest = new RequestType<
  DocumentSymbolParams,
  Array<DocumentSymbol | SymbolInformation> | null,
  void
>("textDocument/documentSymbol");
const ClientRegisterCapabilityRequest = new RequestType<unknown, null, void>(
  "client/registerCapability",
);
const ClientUnregisterCapabilityRequest = new RequestType<unknown, null, void>(
  "client/unregisterCapability",
);
const WorkspaceConfigurationRequest = new RequestType<
  { items?: unknown[] },
  unknown[],
  void
>("workspace/configuration");
const WorkspaceFoldersRequest = new RequestType<
  void,
  Array<{ uri: string; name: string }> | null,
  void
>("workspace/workspaceFolders");
const HoverRequest = new RequestType<
  {
    textDocument: { uri: string };
    position: { line: number; character: number };
  },
  Hover | null,
  void
>("textDocument/hover");
const DocumentDiagnosticRequestType = new RequestType<
  DocumentDiagnosticParams,
  DocumentDiagnosticReport,
  void
>("textDocument/diagnostic");
const SHUTDOWN_TIMEOUT_MS = 1_000;

function buildClientCapabilities(): InitializeParams["capabilities"] {
  // Some servers, including PowerShell Editor Services, assume standard
  // capability objects exist while deriving registration options. Advertise the
  // conservative capabilities SDL actually uses instead of a diagnostics-only
  // shape that leaves optional protocol branches undefined.
  return {
    general: {
      positionEncodings: ["utf-16"],
    },
    window: {
      workDoneProgress: false,
    },
    workspace: {
      workspaceFolders: true,
      configuration: false,
      didChangeConfiguration: {
        dynamicRegistration: false,
      },
    },
    textDocument: {
      synchronization: {
        dynamicRegistration: false,
        willSave: false,
        willSaveWaitUntil: false,
        didSave: true,
      },
      documentSymbol: {
        dynamicRegistration: false,
        hierarchicalDocumentSymbolSupport: true,
        symbolKind: {
          valueSet: [
            SymbolKind.File,
            SymbolKind.Module,
            SymbolKind.Namespace,
            SymbolKind.Package,
            SymbolKind.Class,
            SymbolKind.Method,
            SymbolKind.Property,
            SymbolKind.Field,
            SymbolKind.Constructor,
            SymbolKind.Enum,
            SymbolKind.Interface,
            SymbolKind.Function,
            SymbolKind.Variable,
            SymbolKind.Constant,
            SymbolKind.String,
            SymbolKind.Number,
            SymbolKind.Boolean,
            SymbolKind.Array,
            SymbolKind.Object,
            SymbolKind.Key,
            SymbolKind.Null,
            SymbolKind.EnumMember,
            SymbolKind.Struct,
            SymbolKind.Event,
            SymbolKind.Operator,
            SymbolKind.TypeParameter,
          ],
        },
      },
      definition: {
        dynamicRegistration: false,
        linkSupport: false,
      },
      references: {
        dynamicRegistration: false,
      },
      hover: {
        dynamicRegistration: false,
        contentFormat: ["markdown", "plaintext"],
      },
      rename: {
        dynamicRegistration: false,
        prepareSupport: false,
      },
      diagnostic: {
        dynamicRegistration: false,
        relatedDocumentSupport: false,
      },
    },
  };
}

export interface LspClientOptions {
  serverId: string;
  command: string;
  args?: string[];
  workspaceRoot: string;
  timeoutMs: number;
  env?: Record<string, string>;
  initializationOptions?: Record<string, unknown>;
}

export interface LspTextDocument {
  uri: string;
  languageId: string;
  version: number;
  text: string;
}

export interface LspSpawnCommand {
  command: string;
  args: string[];
  shell: boolean;
}

export function resolveLspSpawnCommand(options: {
  command: string;
  args?: string[];
  platform?: NodeJS.Platform;
  cwd?: string;
  envPath?: string;
  pathExt?: string;
  nodeExecPath?: string;
  readFileText?: (path: string) => string;
  fileExists?: (path: string) => boolean;
}): LspSpawnCommand {
  const platform = options.platform ?? process.platform;
  const args = options.args ?? [];
  const command = unwrapWindowsCommandShim(options.command);
  const resolvedCommand =
    platform === "win32" ? resolveWindowsCommand(command, options) : command;

  if (platform === "win32" && hasWindowsCommandShimExtension(resolvedCommand)) {
    const entrypoint = resolveNpmCommandShimEntrypoint(
      resolvedCommand,
      options.readFileText ?? ((path) => readFileSync(path, "utf8")),
    );
    if (!entrypoint) {
      const rubyEntrypoint = resolveRubyGemsCommandShimEntrypoint(
        resolvedCommand,
        options.readFileText ?? ((path) => readFileSync(path, "utf8")),
      );
      if (rubyEntrypoint) {
        return {
          command: "ruby.exe",
          args: [rubyEntrypoint, ...args],
          shell: false,
        };
      }
    }
    if (!entrypoint) {
      const javaJarEntrypoint = resolveJavaJarCommandShimEntrypoint(
        resolvedCommand,
        options.readFileText ?? ((path) => readFileSync(path, "utf8")),
      );
      if (javaJarEntrypoint) {
        return {
          command: "java.exe",
          args: ["-jar", javaJarEntrypoint, ...args],
          shell: false,
        };
      }
    }
    if (!entrypoint) {
      const rscriptEntrypoint = resolveRscriptCommandShimEntrypoint(
        resolvedCommand,
        options.readFileText ?? ((path) => readFileSync(path, "utf8")),
      );
      if (rscriptEntrypoint) {
        return {
          command: rscriptEntrypoint.command,
          args: [...rscriptEntrypoint.args, ...args],
          shell: false,
        };
      }
    }
    if (!entrypoint) {
      throw new Error(
        `Windows LSP command shim ${resolvedCommand} is not a supported JS/Ruby/Java/Rscript shim; ` +
          "configure the server's JS/Ruby/Java/Rscript entrypoint or native executable instead.",
      );
    }
    return {
      command: options.nodeExecPath ?? process.execPath,
      args: [entrypoint, ...args],
      shell: false,
    };
  }

  return {
    command: resolvedCommand,
    args,
    shell: false,
  };
}

function unwrapWindowsCommandShim(command: string): string {
  const trimmed = command.trim();
  return trimmed.startsWith('"') && trimmed.endsWith('"')
    ? trimmed.slice(1, -1)
    : trimmed;
}

function hasWindowsCommandShimExtension(command: string): boolean {
  return /\.(?:cmd|bat)$/iu.test(command);
}

function resolveWindowsCommand(
  command: string,
  options: {
    cwd?: string;
    envPath?: string;
    pathExt?: string;
    fileExists?: (path: string) => boolean;
  },
): string {
  if (/[\\/]/u.test(command) || /^[A-Za-z]:/u.test(command)) {
    return command;
  }

  const pathExts = (
    options.pathExt ??
    process.env.PATHEXT ??
    ".COM;.EXE;.BAT;.CMD"
  )
    .split(";")
    .map((value) => value.trim())
    .filter(Boolean);
  const candidateNames = win32.extname(command)
    ? [command]
    : [command, ...pathExts.map((extension) => `${command}${extension}`)];
  const pathDirs = (options.envPath ?? process.env.PATH ?? "")
    .split(";")
    .filter(Boolean);
  if (options.cwd) pathDirs.unshift(options.cwd);

  const fileExists = options.fileExists ?? existsSync;
  for (const dir of pathDirs) {
    for (const candidateName of candidateNames) {
      const candidate = win32.join(dir, candidateName);
      if (fileExists(candidate)) return candidate;
    }
  }

  return command;
}

function resolveNpmCommandShimEntrypoint(
  shimPath: string,
  readFileText: (path: string) => string,
): string | null {
  let shimText: string;
  try {
    shimText = readFileText(shimPath);
  } catch {
    return null;
  }

  const shimDir = win32.dirname(shimPath);
  for (const line of shimText.split(/\r?\n/u)) {
    if (!line.includes("%*")) continue;
    const quotedPaths = [...line.matchAll(/"([^"]+\.(?:cjs|mjs|js))"/giu)]
      .map((match) => match[1])
      .filter((value) => !/node(?:\.exe)?$/iu.test(value));
    const script = quotedPaths[0];
    if (!script) continue;
    return win32.normalize(script.replace(/%~?dp0%?[\\/]?/giu, `${shimDir}\\`));
  }

  return null;
}

function resolveRubyGemsCommandShimEntrypoint(
  shimPath: string,
  readFileText: (path: string) => string,
): string | null {
  let shimText: string;
  try {
    shimText = readFileText(shimPath);
  } catch {
    return null;
  }

  if (!/@ruby(?:\.exe)?\s+"%~dpn0"\s+%\*/iu.test(shimText)) {
    return null;
  }
  const parsed = win32.parse(shimPath);
  return win32.join(parsed.dir, parsed.name);
}

function resolveJavaJarCommandShimEntrypoint(
  shimPath: string,
  readFileText: (path: string) => string,
): string | null {
  let shimText: string;
  try {
    shimText = readFileText(shimPath);
  } catch {
    return null;
  }

  const shimDir = win32.dirname(shimPath);
  for (const line of shimText.split(/\r?\n/u)) {
    if (!line.includes("%*")) continue;
    const match = line.match(
      /(?:^|\s)(?:@?java(?:\.exe)?)\s+-jar\s+"?([^"\r\n]+?\.jar)"?\s+%\*/iu,
    );
    const jarPath = match?.[1];
    if (!jarPath) continue;
    return win32.normalize(
      jarPath.replace(/%~?dp0%?[\\/]?/giu, `${shimDir}\\`),
    );
  }

  return null;
}

function resolveRscriptCommandShimEntrypoint(
  shimPath: string,
  readFileText: (path: string) => string,
): { command: string; args: string[] } | null {
  let shimText: string;
  try {
    shimText = readFileText(shimPath);
  } catch {
    return null;
  }

  for (const line of shimText.split(/\r?\n/u)) {
    if (!line.includes("%*")) continue;
    const match = line.match(
      /(?:^|\s)(?:"([^"]*Rscript(?:\.exe)?)"|([^"\s]*Rscript(?:\.exe)?))\s+-e\s+"languageserver::run\(\)"\s+%\*/iu,
    );
    const command = match?.[1] ?? match?.[2];
    if (!command) continue;
    return {
      command: win32.normalize(command),
      args: ["-e", "languageserver::run()"],
    };
  }

  return null;
}

interface DiagnosticWaiter {
  uris: Set<string>;
  resolve: () => void;
}

export class SemanticLspClient {
  private readonly options: LspClientOptions;
  private process: ChildProcessWithoutNullStreams | null = null;
  private connection: MessageConnection | null = null;
  private readonly diagnosticsByUri = new Map<string, Diagnostic[]>();
  private readonly diagnosticWaiters: DiagnosticWaiter[] = [];
  private initialized = false;

  constructor(options: LspClientOptions) {
    this.options = options;
  }

  async start(timeoutMs?: number): Promise<InitializeResult> {
    if (this.connection) {
      throw new Error(`LSP client ${this.options.serverId} is already running`);
    }

    const spawnCommand = resolveLspSpawnCommand({
      command: this.options.command,
      args: this.options.args,
      cwd: this.options.workspaceRoot,
    });
    const child = spawn(spawnCommand.command, spawnCommand.args, {
      cwd: this.options.workspaceRoot,
      env: { ...process.env, ...this.options.env },
      stdio: "pipe",
      windowsHide: true,
      shell: spawnCommand.shell,
    });
    const connection = createMessageConnection(
      new StreamMessageReader(child.stdout),
      new StreamMessageWriter(child.stdin),
      NullLogger,
    );
    const rootUri = pathToFileURL(this.options.workspaceRoot).toString();
    connection.onRequest(ClientRegisterCapabilityRequest, () => null);
    connection.onRequest(ClientUnregisterCapabilityRequest, () => null);
    connection.onRequest(WorkspaceConfigurationRequest, (params) =>
      new Array(params.items?.length ?? 0).fill(null),
    );
    connection.onRequest(WorkspaceFoldersRequest, () => [
      {
        uri: rootUri,
        name: this.options.serverId,
      },
    ]);
    connection.onNotification(PublishDiagnosticsNotification, (params) => {
      this.diagnosticsByUri.set(params.uri, params.diagnostics);
      this.notifyDiagnosticWaiters();
    });
    connection.listen();

    this.process = child;
    this.connection = connection;

    const result = await this.sendRequest(
      InitializeRequest,
      {
        processId: process.pid,
        rootUri,
        capabilities: buildClientCapabilities(),
        workspaceFolders: [
          {
            uri: rootUri,
            name: this.options.serverId,
          },
        ],
        initializationOptions: this.options.initializationOptions,
      },
      timeoutMs,
    );
    await connection.sendNotification(InitializedNotification, {});
    this.initialized = true;
    return result;
  }

  async openDocument(document: LspTextDocument): Promise<void> {
    this.ensureInitialized();
    const params: DidOpenTextDocumentParams = {
      textDocument: {
        uri: document.uri,
        languageId: document.languageId,
        version: document.version,
        text: document.text,
      } satisfies TextDocumentItem,
    };
    await this.connection?.sendNotification(
      DidOpenTextDocumentNotification,
      params,
    );
  }

  async changeDocument(
    document: Pick<LspTextDocument, "uri" | "version">,
    changes: TextDocumentContentChangeEvent[],
  ): Promise<void> {
    this.ensureInitialized();
    const params: DidChangeTextDocumentParams = {
      textDocument: {
        uri: document.uri,
        version: document.version,
      } satisfies VersionedTextDocumentIdentifier,
      contentChanges: changes,
    };
    await this.connection?.sendNotification(
      DidChangeTextDocumentNotification,
      params,
    );
  }

  async definition(
    params: DefinitionParams,
    timeoutMs?: number,
  ): Promise<Location | Location[] | LocationLink[] | null> {
    this.ensureInitialized();
    return this.sendRequest(DefinitionRequest, params, timeoutMs);
  }

  async references(params: ReferenceParams): Promise<Location[] | null> {
    this.ensureInitialized();
    return this.sendRequest(ReferencesRequest, params);
  }

  async documentSymbol(
    params: DocumentSymbolParams,
    timeoutMs?: number,
  ): Promise<Array<DocumentSymbol | SymbolInformation> | null> {
    this.ensureInitialized();
    return this.sendRequest(DocumentSymbolRequest, params, timeoutMs);
  }

  async hover(
    uri: string,
    position: { line: number; character: number },
  ): Promise<Hover | null> {
    this.ensureInitialized();
    return this.sendRequest(HoverRequest, {
      textDocument: { uri },
      position,
    });
  }

  diagnostics(uri: string): Diagnostic[] {
    return this.diagnosticsByUri.get(uri) ?? [];
  }

  async pullDiagnostics(
    uri: string,
    timeoutMs?: number,
  ): Promise<Diagnostic[]> {
    this.ensureInitialized();
    const report = await this.sendRequest(
      DocumentDiagnosticRequestType,
      { textDocument: { uri } },
      timeoutMs,
    );
    const diagnostics =
      report.kind === "full"
        ? report.items
        : (this.diagnosticsByUri.get(uri) ?? []);
    this.diagnosticsByUri.set(uri, diagnostics);
    this.notifyDiagnosticWaiters();
    return diagnostics;
  }

  async waitForDiagnostics(
    uris: readonly string[],
    timeoutMs: number,
  ): Promise<void> {
    this.ensureInitialized();
    if (timeoutMs <= 0 || uris.every((uri) => this.diagnosticsByUri.has(uri))) {
      return;
    }

    await new Promise<void>((resolve) => {
      const waiter: DiagnosticWaiter = {
        uris: new Set(uris),
        resolve: () => undefined,
      };
      const timeout = setTimeout(() => {
        this.removeDiagnosticWaiter(waiter);
        resolve();
      }, timeoutMs);
      waiter.resolve = () => {
        clearTimeout(timeout);
        this.removeDiagnosticWaiter(waiter);
        resolve();
      };
      this.diagnosticWaiters.push(waiter);
      this.notifyDiagnosticWaiters();
    });
  }

  async dispose(): Promise<void> {
    const connection = this.connection;
    if (connection) {
      try {
        if (this.initialized) {
          await this.sendRequest(
            ShutdownRequest,
            undefined,
            SHUTDOWN_TIMEOUT_MS,
          );
          await connection.sendNotification(ExitNotification);
        }
      } catch {
        // Some language servers ignore shutdown once indexing is complete. SDL
        // still owns the transport and must release the child process promptly.
        await connection
          .sendNotification(ExitNotification)
          .catch(() => undefined);
      } finally {
        try {
          connection.dispose();
        } catch {
          // The transport can already be closed if the language server exited
          // after answering its final request; cleanup should remain best-effort.
        }
      }
    }
    if (this.process && !this.process.killed) {
      this.process.kill();
    }
    this.connection = null;
    this.process = null;
    this.initialized = false;
    for (const waiter of [...this.diagnosticWaiters]) {
      waiter.resolve();
    }
  }

  private notifyDiagnosticWaiters(): void {
    for (const waiter of [...this.diagnosticWaiters]) {
      if ([...waiter.uris].every((uri) => this.diagnosticsByUri.has(uri))) {
        waiter.resolve();
      }
    }
  }

  private removeDiagnosticWaiter(waiter: DiagnosticWaiter): void {
    const index = this.diagnosticWaiters.indexOf(waiter);
    if (index >= 0) this.diagnosticWaiters.splice(index, 1);
  }

  private async sendRequest<P, R>(
    requestType: RequestType<P, R, void>,
    params: P,
    timeoutMs = this.options.timeoutMs,
  ): Promise<R> {
    if (!this.connection) {
      throw new Error(`LSP client ${this.options.serverId} is not running`);
    }
    let timeout: NodeJS.Timeout | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        // Do not dispatch JSON-RPC cancellation here. Several real LSP servers
        // close the transport while a long request is timing out; sending
        // $/cancelRequest through a closed connection leaks a second failure
        // after the actionable timeout error. dispose() owns transport cleanup.
        reject(
          new Error(
            `LSP request ${requestType.method} timed out after ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);
    });
    try {
      return await Promise.race([
        this.connection.sendRequest(requestType, params),
        timeoutPromise,
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private ensureInitialized(): void {
    if (!this.connection || !this.initialized) {
      throw new Error(`LSP client ${this.options.serverId} is not initialized`);
    }
  }
}
