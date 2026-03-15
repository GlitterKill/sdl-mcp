/**
 * Min-heap data structure for efficient priority queue operations.
 * Used in beam search to maintain sorted frontier with O(log n) operations.
 *
 * @template T - Type of items in the heap (must have a numeric score property)
 */
export class MinHeap<
  T extends { score: number; priority?: number; sequence?: number },
> {
  private heap: T[] = [];

  /**
   * Insert an item into the heap.
   * Time complexity: O(log n)
   *
   * @param item - Item to insert (must have a score property)
   */
  insert(item: T): void {
    this.heap.push(item);
    this.bubbleUp(this.heap.length - 1);
  }

  /**
   * Remove and return the item with the lowest score.
   * Time complexity: O(log n)
   *
   * @returns Item with minimum score, or undefined if heap is empty
   */
  extractMin(): T | undefined {
    if (this.heap.length === 0) {
      return undefined;
    }

    if (this.heap.length === 1) {
      return this.heap.pop();
    }

    const min = this.heap[0];
    const last = this.heap.pop()!;
    this.heap[0] = last;
    this.bubbleDown(0);
    return min;
  }

  /**
   * Peek at the item with the lowest score without removing it.
   * Time complexity: O(1)
   *
   * @returns Item with minimum score, or undefined if heap is empty
   */
  peek(): T | undefined {
    return this.heap[0];
  }

  /**
   * Check if the heap is empty.
   * Time complexity: O(1)
   *
   * @returns true if heap has no items
   */
  isEmpty(): boolean {
    return this.heap.length === 0;
  }

  /**
   * Get the number of items in the heap.
   * Time complexity: O(1)
   *
   * @returns Number of items in the heap
   */
  size(): number {
    return this.heap.length;
  }

  /**
   * Convert heap to array sorted by score (lowest to highest).
   * This is a destructive operation - empties the heap.
   *
   * @returns Array of items sorted by score (lowest to highest)
   */
  toArray(): T[] {
    const sorted: T[] = [];
    while (!this.isEmpty()) {
      sorted.push(this.extractMin()!);
    }
    return sorted;
  }

  /**
   * Get items as array in heap order (not sorted).
   * This is non-destructive.
   *
   * @returns Copy of internal heap array
   */
  toHeapArray(): T[] {
    return [...this.heap];
  }

  /**
   * Peek at the top N items without removing them.
   * Returns items sorted from lowest to highest score.
   * Time complexity: O(n log n) where n = min(count, heap size)
   *
   * @param count - Maximum number of items to return
   * @returns Array of up to `count` items with lowest scores
   */
  peekTopN(count: number): T[] {
    if (this.heap.length === 0 || count <= 0) {
      return [];
    }
    const n = Math.min(count, this.heap.length);
    // For small peeks, extract-and-reinsert is efficient
    const result: T[] = [];
    const extracted: T[] = [];
    for (let i = 0; i < n; i++) {
      const item = this.extractMin();
      if (!item) break;
      result.push(item);
      extracted.push(item);
    }
    // Re-insert extracted items to restore the heap
    for (const item of extracted) {
      this.insert(item);
    }
    return result;
  }

  /**
   * Clear all items from the heap.
   */
  clear(): void {
    this.heap = [];
  }

  /**
   * Move item at index up to restore heap property.
   *
   * @param index - Index of item to bubble up
   */
  private bubbleUp(index: number): void {
    while (index > 0) {
      const parentIndex = Math.floor((index - 1) / 2);
      if (this.compare(this.heap[parentIndex], this.heap[index]) <= 0) {
        break;
      }
      this.swap(parentIndex, index);
      index = parentIndex;
    }
  }

  /**
   * Move item at index down to restore heap property.
   *
   * @param index - Index of item to bubble down
   */
  private bubbleDown(index: number): void {
    const length = this.heap.length;
    for (;;) {
      let smallest = index;
      const left = 2 * index + 1;
      const right = 2 * index + 2;

      if (
        left < length &&
        this.compare(this.heap[left], this.heap[smallest]) < 0
      ) {
        smallest = left;
      }

      if (
        right < length &&
        this.compare(this.heap[right], this.heap[smallest]) < 0
      ) {
        smallest = right;
      }

      if (smallest === index) {
        break;
      }

      this.swap(smallest, index);
      index = smallest;
    }
  }

  /**
   * Swap two items in the heap array.
   *
   * @param i - First index
   * @param j - Second index
   */
  private swap(i: number, j: number): void {
    [this.heap[i], this.heap[j]] = [this.heap[j], this.heap[i]];
  }

  /**
   * Compare two heap items with deterministic tie-breakers.
   * Lower score is better; ties are broken by priority and then insertion sequence.
   */
  private compare(a: T, b: T): number {
    if (a.score !== b.score) return a.score - b.score;
    const aPriority = a.priority ?? 0;
    const bPriority = b.priority ?? 0;
    if (aPriority !== bPriority) return aPriority - bPriority;
    const aSequence = a.sequence ?? 0;
    const bSequence = b.sequence ?? 0;
    return aSequence - bSequence;
  }
}
