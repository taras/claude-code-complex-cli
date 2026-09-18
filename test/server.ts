import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

export interface TestServer {
  url(path: string): string;
  readonly maxInflight: number;
  readonly inflight: number;
  readonly started: string[];
  readonly aborted: string[];
  readonly finished: string[];
  close(): Promise<void>;
}

/**
 * Endpoints:
 *   /file/:name?chunks=N&delay=MS  stream N chunks, MS apart
 *   /fail/:name?delay=MS           respond 500 after MS
 */
export async function startServer(): Promise<TestServer> {
  let inflight = 0;
  let maxInflight = 0;
  let started: string[] = [];
  let aborted: string[] = [];
  let finished: string[] = [];

  let server: Server = createServer(async (req, res) => {
    let url = new URL(req.url!, "http://localhost");
    let name = url.pathname.split("/").pop()!;
    let chunks = Number(url.searchParams.get("chunks") ?? 2);
    let gap = Number(url.searchParams.get("delay") ?? 20);
    let size = Number(url.searchParams.get("size") ?? 0);

    inflight++;
    maxInflight = Math.max(maxInflight, inflight);
    started.push(name);

    let settled = false;
    let done = (bucket: string[]) => {
      if (!settled) {
        settled = true;
        inflight--;
        bucket.push(name);
      }
    };
    res.on("close", () => {
      if (!res.writableFinished) {
        done(aborted);
      }
    });
    res.on("finish", () => done(finished));

    if (url.pathname.startsWith("/fail/")) {
      await delay(gap);
      if (!res.destroyed) {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end("boom");
      }
      return;
    }

    res.writeHead(200, { "content-type": "application/octet-stream" });
    for (let i = 0; i < chunks; i++) {
      await delay(gap);
      if (res.destroyed) {
        return;
      }
      res.write(size > 0 ? Buffer.alloc(size, "x") : `${name}:${i}\n`);
    }
    res.end();
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  let { port } = server.address() as { port: number };

  return {
    url: (path) => `http://127.0.0.1:${port}${path}`,
    get maxInflight() {
      return maxInflight;
    },
    get inflight() {
      return inflight;
    },
    started,
    aborted,
    finished,
    async close() {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
  };
}

export function expectedBody(name: string, chunks = 2): string {
  return Array.from({ length: chunks }, (_, i) => `${name}:${i}\n`).join("");
}
