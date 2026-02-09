// MCP servers must use stderr for ALL logging - stdout is reserved for JSON-RPC
const writeToStderr = (msg) => {
    process.stderr.write(msg + "\n");
};
function safeStringify(obj) {
    try {
        return JSON.stringify(obj);
    }
    catch (e) {
        return "[circular or unstringifiable]";
    }
}
class Logger {
    level;
    constructor(level = "info") {
        this.level = level;
    }
    shouldLog(level) {
        const levels = ["debug", "info", "warn", "error"];
        return levels.indexOf(level) >= levels.indexOf(this.level);
    }
    setLevel(level) {
        this.level = level;
    }
    debug(message, meta) {
        if (this.shouldLog("debug")) {
            const metaStr = meta ? " " + safeStringify(meta) : "";
            writeToStderr(`[DEBUG] ${message}${metaStr}`);
        }
    }
    info(message, meta) {
        if (this.shouldLog("info")) {
            const metaStr = meta ? " " + safeStringify(meta) : "";
            writeToStderr(`[INFO] ${message}${metaStr}`);
        }
    }
    warn(message, meta) {
        if (this.shouldLog("warn")) {
            const metaStr = meta ? " " + safeStringify(meta) : "";
            writeToStderr(`[WARN] ${message}${metaStr}`);
        }
    }
    error(message, meta) {
        if (this.shouldLog("error")) {
            const metaStr = meta ? " " + safeStringify(meta) : "";
            writeToStderr(`[ERROR] ${message}${metaStr}`);
        }
    }
}
export const logger = new Logger();
//# sourceMappingURL=logger.js.map