import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A tiny HTTP server for the download tests.
 *
 * Routes:
 *   /file/<name>   200, body sent and ended immediately
 *   /gate/<name>   200, headers + a partial body, then held open until
 *                  `release()` is called
 *   /fail/<name>   500, no body
 *   /hold-fail/<name>
 *                  held open with nothing written until `fail()` is called,
 *                  at which point it answers 500
 */
export interface TestServer {
  url(path: string): string;
  /** Paths of every request the server has accepted, in arrival order. */
  readonly requests: readonly string[];
  /** Requests currently being handled. */
  readonly inflight: number;
  /** The largest value `inflight` has ever had. */
  readonly peakInflight: number;
  /** Finish every held response, and every held response opened afterwards. */
  release(): void;
  /** Answer every held `/hold-fail/` response with a 500. */
  fail(): void;
  close(): Promise<void>;
}

export const GATE_HEAD = "part";
export const GATE_TAIL = "-the-rest";

export async function startTestServer(): Promise<TestServer> {
  let requests: string[] = [];
  let inflight = 0;
  let peakInflight = 0;
  let released = false;
  let held = new Set<ServerResponse>();
  let failable = new Set<ServerResponse>();

  function open(): void {
    inflight += 1;
    peakInflight = Math.max(peakInflight, inflight);
  }

  function close(res: ServerResponse): void {
    if (held.delete(res)) {
      inflight -= 1;
    }
  }

  let server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let path = req.url ?? "/";
    requests.push(path);
    open();
    held.add(res);
    res.on("close", () => close(res));

    if (path.startsWith("/hold-fail/")) {
      failable.add(res);
      res.on("close", () => failable.delete(res));
      return;
    }

    if (path.startsWith("/fail/")) {
      res.writeHead(500, "Internal Server Error");
      res.end();
      return;
    }

    if (path.startsWith("/gate/")) {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.write(GATE_HEAD);
      if (released) {
        res.end(GATE_TAIL);
      }
      return;
    }

    res.writeHead(200, { "content-type": "text/plain" });
    res.end(bodyFor(path));
  });

  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));

  let { port } = server.address() as AddressInfo;

  function fail(): void {
    for (let res of [...failable]) {
      failable.delete(res);
      res.writeHead(500, "Internal Server Error");
      res.end();
    }
  }

  function release(): void {
    released = true;
    for (let res of [...held]) {
      res.end(GATE_TAIL);
    }
  }

  return {
    url: (path) => `http://127.0.0.1:${port}${path}`,
    requests,
    get inflight() {
      return inflight;
    },
    get peakInflight() {
      return peakInflight;
    },
    release,
    fail,
    async close() {
      release();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** The body `/file/<name>` responds with. */
export function bodyFor(path: string): string {
  return `contents of ${path}\n`;
}
