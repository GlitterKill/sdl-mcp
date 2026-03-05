declare module "node:sqlite" {
  export interface DatabaseSyncOptions {
    readonly?: boolean;
    fileMustExist?: boolean;
  }

  export class DatabaseSync {
    constructor(path: string, options?: DatabaseSyncOptions);
    prepare(statement: string): StatementSync;
    exec(statement: string): void;
    close(): void;
  }

  export class StatementSync {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
    iterate(...params: unknown[]): Iterable<unknown>;
    run(...params: unknown[]): unknown;
  }
}
