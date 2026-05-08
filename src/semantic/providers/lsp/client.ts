import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { pathToFileURL } from "node:url";

import {
  CancellationTokenSource,
  createMessageConnection,
  NullLogger,
  NotificationType,
  RequestType,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from "vscode-jsonrpc/node.js";
import type {
  DefinitionParams,
  DidChangeTextDocumentParams,
  DidOpenTextDocumentParams,
  DocumentSymbol,
  Hover,
  InitializeParams,
  InitializeResult,
  Location,
  LocationLink,
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
  { textDocument: { uri: string } },
  DocumentSymbol[] | SymbolInformation[] | null,
  void
>("textDocument/documentSymbol");
const HoverRequest = new RequestType<
  {
    textDocument: { uri: string };
    position: { line: number; character: number };
  },
  Hover | null,
  void
>("textDocument/hover");

export interface LspClientOptions {
  serverId: string;
  command: string;
  args?: string[];
  workspaceRoot: string;
  timeoutMs: number;
  initializationOptions?: Record<string, unknown>;
}

export interface LspTextDocument {
  uri: string;
  languageId: string;
  version: number;
  text: string;
}

export class SemanticLspClient {
  private readonly options: LspClientOptions;
  private process: ChildProcessWithoutNullStreams | null = null;
  private connection: MessageConnection | null = null;
  private initialized = false;

  constructor(options: LspClientOptions) {
    this.options = options;
  }

  async start(timeoutMs?: number): Promise<InitializeResult> {
    if (this.connection) {
      throw new Error(`LSP client ${this.options.serverId} is already running`);
    }

    const child = spawn(this.options.command, this.options.args ?? [], {
      cwd: this.options.workspaceRoot,
      stdio: "pipe",
      windowsHide: true,
    });
    const connection = createMessageConnection(
      new StreamMessageReader(child.stdout),
      new StreamMessageWriter(child.stdin),
      NullLogger,
    );
    connection.listen();

    this.process = child;
    this.connection = connection;

    const rootUri = pathToFileURL(this.options.workspaceRoot).toString();
    const result = await this.sendRequest(
      InitializeRequest,
      {
        processId: process.pid,
        rootUri,
        capabilities: {},
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

  async documentSymbols(
    uri: string,
  ): Promise<DocumentSymbol[] | SymbolInformation[] | null> {
    this.ensureInitialized();
    return this.sendRequest(DocumentSymbolRequest, { textDocument: { uri } });
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

  async dispose(): Promise<void> {
    const connection = this.connection;
    if (connection) {
      if (this.initialized) {
        await this.sendRequest(ShutdownRequest, undefined);
        await connection.sendNotification(ExitNotification);
      }
      connection.dispose();
    }
    if (this.process && !this.process.killed) {
      this.process.kill();
    }
    this.connection = null;
    this.process = null;
    this.initialized = false;
  }

  private async sendRequest<P, R>(
    requestType: RequestType<P, R, void>,
    params: P,
    timeoutMs = this.options.timeoutMs,
  ): Promise<R> {
    if (!this.connection) {
      throw new Error(`LSP client ${this.options.serverId} is not running`);
    }
    const cts = new CancellationTokenSource();
    const timeout = setTimeout(() => {
      cts.cancel();
    }, timeoutMs);
    try {
      return await this.connection.sendRequest(requestType, params, cts.token);
    } finally {
      clearTimeout(timeout);
      cts.dispose();
    }
  }

  private ensureInitialized(): void {
    if (!this.connection || !this.initialized) {
      throw new Error(`LSP client ${this.options.serverId} is not initialized`);
    }
  }
}
