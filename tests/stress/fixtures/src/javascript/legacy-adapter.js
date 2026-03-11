/**
 * Legacy Adapter — primary JavaScript fixture.
 * Defines adapter functions and a class for bridging old/new APIs.
 */

class LegacyAdapter {
  constructor(endpoint) {
    this.endpoint = endpoint;
    this.cache = new Map();
  }

  async fetchData(resourceId) {
    if (this.cache.has(resourceId)) {
      return this.cache.get(resourceId);
    }
    const result = { id: resourceId, fetched: true, timestamp: Date.now() };
    this.cache.set(resourceId, result);
    return result;
  }

  clearCache() {
    this.cache.clear();
  }

  getCacheSize() {
    return this.cache.size;
  }
}

function transformResponse(raw) {
  return {
    id: raw.id,
    data: raw.payload ?? raw.data,
    status: raw.statusCode ?? raw.status ?? 200,
  };
}

function validatePayload(payload) {
  if (!payload || typeof payload !== "object") return false;
  if (!payload.id || typeof payload.id !== "string") return false;
  return true;
}

function createBatchProcessor(batchSize) {
  const queue = [];
  return {
    add(item) {
      queue.push(item);
    },
    async flush() {
      const batches = [];
      for (let i = 0; i < queue.length; i += batchSize) {
        batches.push(queue.slice(i, i + batchSize));
      }
      queue.length = 0;
      return batches;
    },
  };
}

module.exports = {
  LegacyAdapter,
  transformResponse,
  validatePayload,
  createBatchProcessor,
};
