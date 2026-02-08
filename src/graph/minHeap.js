/**
 * Min-heap data structure for efficient priority queue operations.
 * Used in beam search to maintain sorted frontier with O(log n) operations.
 *
 * @template T - Type of items in the heap (must have a numeric score property)
 */
export class MinHeap {
    heap = [];
    /**
     * Insert an item into the heap.
     * Time complexity: O(log n)
     *
     * @param item - Item to insert (must have a score property)
     */
    insert(item) {
        this.heap.push(item);
        this.bubbleUp(this.heap.length - 1);
    }
    /**
     * Remove and return the item with the lowest score.
     * Time complexity: O(log n)
     *
     * @returns Item with minimum score, or undefined if heap is empty
     */
    extractMin() {
        if (this.heap.length === 0) {
            return undefined;
        }
        if (this.heap.length === 1) {
            return this.heap.pop();
        }
        const min = this.heap[0];
        const last = this.heap.pop();
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
    peek() {
        return this.heap[0];
    }
    /**
     * Check if the heap is empty.
     * Time complexity: O(1)
     *
     * @returns true if heap has no items
     */
    isEmpty() {
        return this.heap.length === 0;
    }
    /**
     * Get the number of items in the heap.
     * Time complexity: O(1)
     *
     * @returns Number of items in the heap
     */
    size() {
        return this.heap.length;
    }
    /**
     * Convert heap to array sorted by score (lowest to highest).
     * This is a destructive operation - empties the heap.
     *
     * @returns Array of items sorted by score (lowest to highest)
     */
    toArray() {
        const sorted = [];
        while (!this.isEmpty()) {
            sorted.push(this.extractMin());
        }
        return sorted;
    }
    /**
     * Get items as array in heap order (not sorted).
     * This is non-destructive.
     *
     * @returns Copy of internal heap array
     */
    toHeapArray() {
        return [...this.heap];
    }
    /**
     * Clear all items from the heap.
     */
    clear() {
        this.heap = [];
    }
    /**
     * Move item at index up to restore heap property.
     *
     * @param index - Index of item to bubble up
     */
    bubbleUp(index) {
        while (index > 0) {
            const parentIndex = Math.floor((index - 1) / 2);
            if (this.heap[parentIndex].score <= this.heap[index].score) {
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
    bubbleDown(index) {
        const length = this.heap.length;
        while (true) {
            let smallest = index;
            const left = 2 * index + 1;
            const right = 2 * index + 2;
            if (left < length && this.heap[left].score < this.heap[smallest].score) {
                smallest = left;
            }
            if (right < length &&
                this.heap[right].score < this.heap[smallest].score) {
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
    swap(i, j) {
        [this.heap[i], this.heap[j]] = [this.heap[j], this.heap[i]];
    }
}
//# sourceMappingURL=minHeap.js.map