function buildRepoUrl(config, path) {
  return `${config.serverUrl.replace(/\/+$/, "")}/api/repo/${encodeURIComponent(config.repoId)}${path}`;
}

function createLiveSyncClient(deps = {}) {
  const requestJson = deps.requestJson ?? (async (url, options) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(await response.text());
      }
      return response.json();
    } finally {
      clearTimeout(timeout);
    }
  });

  return {
    async pushBufferEvent(config, payload) {
      return requestJson(buildRepoUrl(config, "/buffer"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    },

    async requestCheckpoint(config, payload = {}) {
      return requestJson(buildRepoUrl(config, "/checkpoint"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    },

    async pushSaveWithFallback(config, payload) {
      try {
        return await this.pushBufferEvent(config, {
          ...payload,
          eventType: "save",
        });
      } catch (error) {
        if (!config.enableOnSaveReindex) {
          throw error;
        }
        return requestJson(buildRepoUrl(config, "/reindex"), {
          method: "POST",
        });
      }
    },
  };
}

module.exports = {
  createLiveSyncClient,
};
