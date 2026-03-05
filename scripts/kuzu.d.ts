declare module "kuzu" {
  export class Database {
    constructor(path: string, bufferPoolSize?: number);
    close(): void;
  }

  export class Connection {
    constructor(db: Database);
    query(query: string, params?: Record<string, unknown>): Promise<QueryResult>;
    close(): void;
  }

  export class QueryResult {
    hasNext(): boolean;
    getNext(): Record<string, unknown>;
    close(): void;
  }
}
