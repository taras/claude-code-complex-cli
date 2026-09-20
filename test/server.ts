import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { type AddressInfo } from "node:net";
import { ensure, type Operation, resource, until } from "effection";

export interface ServerStats {
  started: string[];
  active: number;
  maxActive: number;
  finished: string[];
  aborted: string[];
}

export interface TestServer {
  url(path: string): string;
  stats: ServerStats;
}

/**
 * An http server for exercising downloads. Paths are `/<kind>/<name>`, where
 * kind is one of `fast`, `slow`, `hang`, `fail` or `faillate`.
 */
export function useServer(): Operation<TestServer> {
  return resource(function* (provide) {
    let stats: ServerStats = {
      started: [],
      active: 0,
      maxActive: 0,
      finished: [],
      aborted: [],
    };

    let server = createServer((req, res) => handle(stats, req, res));

    yield* ensure(function* () {
      server.closeAllConnections();
      yield* until(new Promise<void>((resolve) => server.close(() => resolve())));
    });

    server.listen(0, "127.0.0.1");
    yield* until(new Promise((resolve) => server.once("listening", resolve)));

    let { port } = server.address() as AddressInfo;

    yield* provide({
      url: (path: string) => `http://127.0.0.1:${port}${path}`,
      stats,
    });
  });
}

const CHUNKS = 4;
const CHUNK_DELAY = 40;

function handle(
  stats: ServerStats,
  req: IncomingMessage,
  res: ServerResponse,
): void {
  let path = req.url ?? "";
  let [, kind = "", name = ""] = path.split("/");

  stats.started.push(path);
  stats.active += 1;
  stats.maxActive = Math.max(stats.maxActive, stats.active);

  let settled = false;
  let timers: NodeJS.Timeout[] = [];

  res.on("close", () => {
    if (settled) {
      return;
    }
    settled = true;
    stats.active -= 1;
    stats.aborted.push(path);
    for (let timer of timers) {
      clearTimeout(timer);
    }
  });

  let finish = () => {
    if (settled) {
      return;
    }
    settled = true;
    stats.active -= 1;
    stats.finished.push(path);
    res.end();
  };

  if (kind === "fail") {
    res.writeHead(500, "Internal Server Error");
    finish();
    return;
  }

  if (kind === "faillate") {
    timers.push(
      setTimeout(() => {
        if (settled) {
          return;
        }
        res.writeHead(500, "Internal Server Error");
        finish();
      }, CHUNK_DELAY * 2 + CHUNK_DELAY / 2),
    );
    return;
  }

  res.writeHead(200, { "content-type": "application/octet-stream" });

  if (kind === "fast") {
    res.write(body(name));
    finish();
    return;
  }

  for (let i = 0; i < CHUNKS; i++) {
    timers.push(
      setTimeout(() => {
        if (settled) {
          return;
        }
        res.write(`${name}-chunk-${i};`);
        if (i === CHUNKS - 1 && kind !== "hang") {
          finish();
        }
      }, CHUNK_DELAY * (i + 1)),
    );
  }
}

export function body(name: string): string {
  return `body of ${name}\n`;
}
