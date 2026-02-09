export type LogLevel = "debug" | "info" | "warn" | "error";
declare class Logger {
    private level;
    constructor(level?: LogLevel);
    private shouldLog;
    setLevel(level: LogLevel): void;
    debug(message: string, meta?: Record<string, unknown>): void;
    info(message: string, meta?: Record<string, unknown>): void;
    warn(message: string, meta?: Record<string, unknown>): void;
    error(message: string, meta?: Record<string, unknown>): void;
}
export declare const logger: Logger;
export {};
