import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface Fixture {
  url(path: string): string;
  /** how many requests the server has begun handling */
  started: number;
  /** the high water mark of simultaneously in-flight requests */
  peak: number;
  release(): void;
  close(): Promise<void>;
}

const CHUNK = "partial-";

export async function startFixture(): Promise<Fixture> {
  const held = new Set<ServerResponse>();
  const sockets = new Set<import("node:net").Socket>();
  let inflight = 0;

  const fixture = {
    started: 0,
    peak: 0,
  } as Fixture;

  function handle(request: IncomingMessage, response: ServerResponse): void {
    fixture.started++;
    inflight++;
    fixture.peak = Math.max(fixture.peak, inflight);

    const done = () => {
      inflight--;
      held.delete(response);
    };
    response.on("close", done);

    const url = new URL(request.url ?? "/", "http://fixture");
    const [, kind] = url.pathname.split("/");

    if (kind === "fail") {
      setTimeout(() => {
        response.writeHead(500, { "content-type": "text/plain" });
        response.end("boom");
      }, Number(url.searchParams.get("ms") ?? 0));
      return;
    }

    if (kind === "stream") {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      const big = "x".repeat(256 * 1024);
      const timer = setInterval(() => {
        if (response.writableEnded) {
          clearInterval(timer);
          return;
        }
        response.write(big);
      }, 2);
      response.on("close", () => clearInterval(timer));
      held.add(response);
      return;
    }

    if (kind === "partial") {
      // headers and one chunk, then hold the response open forever
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.write(CHUNK);
      held.add(response);
      return;
    }

    const body = (url.searchParams.get("body") ?? "hello").repeat(
      Number(url.searchParams.get("repeat") ?? 1),
    );
    const delay = Number(url.searchParams.get("ms") ?? 0);

    if (delay === 0) {
      response.writeHead(200);
      response.end(body);
      return;
    }

    setTimeout(() => {
      if (!response.writableEnded) {
        response.writeHead(200);
        response.end(body);
      }
    }, delay);
  }

  const server = createServer(handle);
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const { port } = server.address() as AddressInfo;

  fixture.url = (path: string) => `http://127.0.0.1:${port}${path}`;

  fixture.release = () => {
    for (const response of held) {
      response.end();
    }
    held.clear();
  };

  fixture.close = async () => {
    fixture.release();
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };

  return fixture;
}

export const PARTIAL_CHUNK = CHUNK;
