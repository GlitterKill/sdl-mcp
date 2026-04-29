/**
 * Generic fixed-capacity ring with timestamped entries.
 *
 * Pure data structure — no I/O, no time dependency beyond the caller-supplied
 * timestamp. Used by the observability aggregator to bound per-repo memory.
 */

export interface RingEntry<T> {
  /** Unix-millis timestamp at which the value was pushed. */
  t: number;
  v: T;
}

/**
 * Fixed-capacity ring buffer. When full, the oldest entry is overwritten.
 * Order of `snapshot()` is from oldest to newest.
 */
export class RingBuffer<T> {
  private readonly capacity: number;
  private readonly buf: Array<RingEntry<T> | undefined>;
  private head = 0;
  private size = 0;

  constructor(capacity: number) {
    if (!Number.isFinite(capacity) || capacity <= 0) {
      throw new Error(
        `RingBuffer capacity must be a positive integer, got ${capacity}`,
      );
    }
    this.capacity = Math.floor(capacity);
    this.buf = new Array<RingEntry<T> | undefined>(this.capacity);
  }

  /**
   * Push a value with an optional timestamp (defaults to `Date.now()`).
   */
  push(value: T, timestamp?: number): void {
    const t = timestamp ?? Date.now();
    this.buf[this.head] = { t, v: value };
    this.head = (this.head + 1) % this.capacity;
    if (this.size < this.capacity) {
      this.size += 1;
    }
  }

  /**
   * Return all entries in oldest-to-newest order.
   * Allocates a new array; suitable for snapshotting state for queries.
   */
  snapshot(): Array<RingEntry<T>> {
    const out: Array<RingEntry<T>> = [];
    if (this.size === 0) return out;
    // The oldest entry sits at (head - size) modulo capacity.
    const start = (this.head - this.size + this.capacity) % this.capacity;
    for (let i = 0; i < this.size; i += 1) {
      const entry = this.buf[(start + i) % this.capacity];
      if (entry !== undefined) out.push(entry);
    }
    return out;
  }

  /**
   * Return entries with `t >= sinceTimestamp`, oldest-to-newest.
   */
  since(sinceTimestamp: number): Array<RingEntry<T>> {
    return this.snapshot().filter((e) => e.t >= sinceTimestamp);
  }

  /**
   * Return current entry count (0 .. capacity).
   */
  length(): number {
    return this.size;
  }

  /**
   * Return capacity.
   */
  getCapacity(): number {
    return this.capacity;
  }

  /**
   * Clear all entries.
   */
  clear(): void {
    for (let i = 0; i < this.buf.length; i += 1) this.buf[i] = undefined;
    this.head = 0;
    this.size = 0;
  }
}
