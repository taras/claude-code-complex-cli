import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

export interface TestServer {
  origin: string;
  url(path: string): string;
  /** Paths of every request the server has received, in arrival order. */
  requests: string[];
  /** Paths of requests whose socket closed before the response finished. */
  aborted: string[];
  /** Number of requests currently being served. */
  active(): number;
  /** High-water mark of concurrently served requests. */
  maxActive: number;
  /** Let every held response finish; later held requests finish immediately. */
  release(): void;
  /** Clear recorded traffic and go back to holding `/hold/` responses. */
  reset(): void;
  close(): Promise<void>;
}

/**
 * Routes:
 *   /instant/<name>        200, body sent and ended immediately
 *   /hold/<name>?head=<n>  200, sends <n> bytes then holds open until released
 *   /fail/<name>           500, no body
 *   /delay/<name>?ms=<n>   200, body sent after <n> milliseconds
 */
export async function startTestServer(): Promise<TestServer> {
  let requests: string[] = [];
  let aborted: string[] = [];
  let held = new Set<() => void>();
  let releasedAll = false;
  let active = 0;
  let maxActive = 0;

  let release = () => {
    releasedAll = true;
    for (let finish of [...held]) {
      finish();
    }
  };

  let server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let path = req.url ?? "/";
    requests.push(path);

    active += 1;
    maxActive = Math.max(maxActive, active);

    let settled = false;
    let settle = () => {
      if (!settled) {
        settled = true;
        active -= 1;
      }
    };

    res.on("close", () => {
      if (!res.writableEnded) {
        aborted.push(path);
      }
      settle();
    });

    let url = new URL(path, "http://localhost");

    if (url.pathname.startsWith("/fail/")) {
      res.writeHead(500, "Internal Server Error");
      res.end();
      return;
    }

    if (url.pathname.startsWith("/hold/")) {
      let head = Number(url.searchParams.get("head") ?? "16");
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.write(Buffer.alloc(head, 0x61));

      let finish = () => {
        held.delete(finish);
        res.end(Buffer.alloc(8, 0x62));
      };

      if (releasedAll) {
        finish();
        return;
      }

      held.add(finish);
      res.on("close", () => held.delete(finish));
      return;
    }

    if (url.pathname.startsWith("/delay/")) {
      let ms = Number(url.searchParams.get("ms") ?? "10");
      let timer = setTimeout(() => res.end(url.pathname), ms);
      res.on("close", () => clearTimeout(timer));
      return;
    }

    res.writeHead(200, { "content-type": "text/plain" });
    res.end(url.pathname);
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  let { port } = server.address() as AddressInfo;
  let origin = `http://127.0.0.1:${port}`;

  return {
    origin,
    url: (path) => `${origin}${path}`,
    requests,
    aborted,
    active: () => active,
    get maxActive() {
      return maxActive;
    },
    release,
    reset() {
      requests.length = 0;
      aborted.length = 0;
      releasedAll = false;
      maxActive = active;
    },
    async close() {
      release();
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
  };
}
