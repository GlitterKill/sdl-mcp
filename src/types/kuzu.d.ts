declare module "kuzu" {
  export class Database {
    constructor(
      databasePath: string,
      bufferManagerSize?: number,
      enableCompression?: boolean,
      readOnly?: boolean,
      maxDbSize?: number,
      autoCheckpoint?: boolean,
      checkpointThreshold?: number,
      throwOnWalReplayFailure?: boolean,
      enableChecksums?: boolean,
    );
    close(): Promise<void>;
  }

  export class PreparedStatement {
    isSuccess(): boolean;
    getErrorMessage(): string;
  }

  export class Connection {
    constructor(database: Database, numThreads?: number);
    prepare(statement: string): Promise<PreparedStatement>;
    execute(
      preparedStatement: PreparedStatement,
      params?: Record<string, unknown>,
      progressCallback?: (
        pipelineProgress: number,
        numPipelinesFinished: number,
        numPipelines: number,
      ) => void,
    ): Promise<QueryResult>;
    query(
      statement: string,
      progressCallback?: (
        pipelineProgress: number,
        numPipelinesFinished: number,
        numPipelines: number,
      ) => void,
    ): Promise<QueryResult>;
    close(): Promise<void>;
  }

  export interface QueryResult {
    hasNext(): boolean;
    getNext(): Promise<QueryResultRow>;
    getAll(): Promise<QueryResultRow[]>;
    close(): void;
  }

  export interface QueryResultRow {
    [key: string]: unknown;
  }
}
