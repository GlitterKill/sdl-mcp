/**
 * Async file system operations with concurrency control.
 *
 * Wraps Node.js fs operations with async/await and applies
 * concurrency limits to prevent resource exhaustion.
 */

import { readFile, stat, access, constants } from "fs/promises";
import { ConcurrencyLimiter } from "./concurrency.js";

/**
 * Configuration for async file operations.
 */
export interface AsyncFsConfig {
  /**
   * Maximum concurrent file read operations.
   */
  maxConcurrentReads?: number;

  /**
   * Maximum concurrent file stat operations.
   */
  maxConcurrentStats?: number;

  /**
   * Concurrency limiter instance (optional, overrides maxConcurrent settings).
   */
  limiter?: ConcurrencyLimiter;
}

export interface TimedReadFileResult {
  content: string;
  elapsedMs: number;
  queuedMs: number;
  activeMs: number;
}

class AsyncFsOperations {
  private readLimiter: ConcurrencyLimiter;
  private statLimiter: ConcurrencyLimiter;

  constructor(config: AsyncFsConfig = {}) {
    const {
      maxConcurrentReads = 10,
      maxConcurrentStats = 10,
      limiter,
    } = config;

    this.readLimiter =
      limiter ??
      new ConcurrencyLimiter({
        maxConcurrency: maxConcurrentReads,
      });

    this.statLimiter =
      limiter ??
      new ConcurrencyLimiter({
        maxConcurrency: maxConcurrentStats,
      });
  }

  /**
   * Reads a file's content asynchronously with concurrency control.
   *
   * @param filePath - Path to the file to read
   * @param encoding - File encoding (default: "utf-8")
   * @returns Promise that resolves with file content
   */
  async readFile(
    filePath: string,
    encoding: BufferEncoding = "utf-8",
  ): Promise<string> {
    return this.readLimiter.run(() => readFile(filePath, encoding));
  }

  /**
   * Reads raw file bytes asynchronously with the same limiter as text reads.
   * Use this for byte-exact hashing where decoding would change semantics.
   */
  async readFileBuffer(filePath: string): Promise<Buffer> {
    return this.readLimiter.run(() => readFile(filePath));
  }

  /**
   * Reads a file and returns limiter timing attribution for diagnostics.
   *
   * `elapsedMs` is the full caller-observed await time, `queuedMs` is time
   * spent waiting for the shared read limiter, and `activeMs` is the time
   * spent inside the underlying `fs.promises.readFile` call.
   */
  async readFileWithTiming(
    filePath: string,
    encoding: BufferEncoding = "utf-8",
  ): Promise<TimedReadFileResult> {
    const startedAt = Date.now();
    let activeMs = 0;
    const content = await this.readLimiter.run(async () => {
      const activeStartedAt = Date.now();
      try {
        return await readFile(filePath, encoding);
      } finally {
        activeMs = Date.now() - activeStartedAt;
      }
    });
    const elapsedMs = Date.now() - startedAt;
    return {
      content,
      elapsedMs,
      queuedMs: Math.max(0, elapsedMs - activeMs),
      activeMs,
    };
  }

  /**
   * Gets file statistics asynchronously with concurrency control.
   *
   * @param filePath - Path to the file
   * @returns Promise that resolves with file stats
   */
  async stat(filePath: string): Promise<import("fs").Stats> {
    return this.statLimiter.run(() => stat(filePath));
  }

  /**
   * Checks if a file exists asynchronously.
   *
   * @param filePath - Path to check
   * @returns Promise that resolves with true if file exists
   */
  async exists(filePath: string): Promise<boolean> {
    try {
      await access(filePath, constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Checks if a file is readable asynchronously.
   *
   * @param filePath - Path to check
   * @returns Promise that resolves with true if file is readable
   */
  async isReadable(filePath: string): Promise<boolean> {
    try {
      await access(filePath, constants.R_OK);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Gets file size asynchronously with caching hint.
   *
   * @param filePath - Path to the file
   * @returns Promise that resolves with file size in bytes
   */
  async getFileSize(filePath: string): Promise<number> {
    const stats = await this.stat(filePath);
    return stats.size;
  }

  /**
   * Gets file modification time asynchronously.
   *
   * @param filePath - Path to the file
   * @returns Promise that resolves with modification timestamp
   */
  async getMtime(filePath: string): Promise<Date> {
    const stats = await this.stat(filePath);
    return stats.mtime;
  }
}

const defaultInstance: AsyncFsOperations = new AsyncFsOperations();

/**
 * Creates a new async file system operations instance with optional config.
 *
 * @param config - Optional configuration
 * @returns New AsyncFsOperations instance
 */
export function createAsyncFsOperations(
  config?: AsyncFsConfig,
): AsyncFsOperations {
  return new AsyncFsOperations(config);
}

/**
 * Convenience function to read a file with concurrency control.
 *
 * @param filePath - Path to the file
 * @param encoding - File encoding
 * @returns Promise that resolves with file content
 */
export async function readFileAsync(
  filePath: string,
  encoding?: BufferEncoding,
): Promise<string> {
  return defaultInstance.readFile(filePath, encoding);
}

export async function readFileBufferAsync(filePath: string): Promise<Buffer> {
  return defaultInstance.readFileBuffer(filePath);
}

export async function readFileAsyncWithTiming(
  filePath: string,
  encoding?: BufferEncoding,
): Promise<TimedReadFileResult> {
  return defaultInstance.readFileWithTiming(filePath, encoding);
}

/**
 * Convenience function to get file stats with concurrency control.
 *
 * @param filePath - Path to the file
 * @returns Promise that resolves with file stats
 */
export async function statAsync(filePath: string): Promise<import("fs").Stats> {
  return defaultInstance.stat(filePath);
}

/**
 * Convenience function to check if file exists asynchronously.
 *
 * @param filePath - Path to check
 * @returns Promise that resolves with true if file exists
 */
export async function existsAsync(filePath: string): Promise<boolean> {
  return defaultInstance.exists(filePath);
}
