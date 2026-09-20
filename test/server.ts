import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface TestServer {
  url: string;
  activeConnections: () => number;
  requestCount: (path: string) => number;
  close: () => Promise<void>;
}

export interface RouteOptions {
  /** bytes to send per chunk before pausing */
  chunkBytes?: number;
  /** delay in ms between chunks */
  chunkDelayMs?: number;
  /** total number of chunks to send */
  chunkCount?: number;
  /** respond with this HTTP status instead of streaming a body */
  status?: number;
}

export function startTestServer(routes: Record<string, RouteOptions>): Promise<TestServer> {
  let active = 0;
  const requestCounts = new Map<string, number>();

  const server: Server = createServer((req, res) => {
    const path = req.url ?? "";
    requestCounts.set(path, (requestCounts.get(path) ?? 0) + 1);

    const route = routes[path] ?? { chunkCount: 1, chunkBytes: 16 };

    if (route.status && route.status >= 400) {
      res.writeHead(route.status);
      res.end("error");
      return;
    }

    active++;
    res.on("close", () => {
      active--;
    });

    const chunkBytes = route.chunkBytes ?? 1024;
    const chunkCount = route.chunkCount ?? 1;
    const chunkDelayMs = route.chunkDelayMs ?? 0;

    res.writeHead(route.status ?? 200, { "Content-Type": "application/octet-stream" });

    let sent = 0;
    const sendChunk = () => {
      if (sent >= chunkCount) {
        res.end();
        return;
      }
      sent++;
      res.write(Buffer.alloc(chunkBytes, "x"));
      if (chunkDelayMs > 0) {
        setTimeout(sendChunk, chunkDelayMs);
      } else {
        setImmediate(sendChunk);
      }
    };
    sendChunk();
  });

  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        activeConnections: () => active,
        requestCount: (path: string) => requestCounts.get(path) ?? 0,
        close: () =>
          new Promise((res, rej) => {
            server.closeAllConnections();
            server.close((err) => (err ? rej(err) : res()));
          }),
      });
    });
    server.on("error", reject);
  });
}
