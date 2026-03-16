/**
 * Minimal SSE (Server-Sent Events) client using Node.js built-in http module.
 * Used by the CLI index command to stream progress from a running HTTP server.
 */

import { request as httpRequest, type IncomingMessage } from "http";

export interface SSEEvent {
  event: string;
  data: string;
}

export interface SSEClientOptions {
  host: string;
  port: number;
  path: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  onEvent: (event: SSEEvent) => void;
  onError?: (error: Error) => void;
}

/**
 * Connect to an SSE endpoint and invoke `onEvent` for each received event.
 * Returns a promise that resolves when the server closes the stream.
 */
export function connectSSE(options: SSEClientOptions): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: options.host,
        port: options.port,
        path: options.path,
        method: options.method ?? "GET",
        headers: {
          Accept: "text/event-stream",
          ...options.headers,
        },
      },
      (res: IncomingMessage) => {
        if (res.statusCode !== 200) {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            reject(
              new Error(
                `SSE request failed with status ${res.statusCode}: ${body}`,
              ),
            );
          });
          return;
        }

        let buffer = "";

        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          buffer += chunk;

          // SSE events are delimited by double newline
          let boundary: number;
          while ((boundary = buffer.indexOf("\n\n")) !== -1) {
            const raw = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);

            let eventName = "message";
            let data = "";

            for (const line of raw.split("\n")) {
              if (line.startsWith("event: ")) {
                eventName = line.slice(7).trim();
              } else if (line.startsWith("data: ")) {
                data += (data ? "\n" : "") + line.slice(6);
              } else if (line.startsWith("data:")) {
                data += (data ? "\n" : "") + line.slice(5);
              }
            }

            if (eventName || data) {
              options.onEvent({ event: eventName, data });
            }
          }
        });

        res.on("end", resolve);
        res.on("error", (err) => {
          if (options.onError) {
            options.onError(err);
          }
          reject(err);
        });
      },
    );

    req.on("error", (err) => {
      if (options.onError) {
        options.onError(err);
      }
      reject(err);
    });

    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}
