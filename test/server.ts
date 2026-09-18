import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import { AddressInfo } from "node:net";

export interface RequestRecord {
  path: string;
  startedAt: number;
  endedAt?: number;
  /** true when the full body was delivered to the client */
  completed: boolean;
  /** true when the client went away before the body was delivered */
  aborted: boolean;
}

/**
 * A test origin server that can serve files slowly, fail on demand, and
 * report exactly how much work it did and how much of it overlapped.
 */
export class TestServer {
  #server: Server;
  #inFlight = 0;

  readonly requests: RequestRecord[] = [];
  maxInFlight = 0;
  port = 0;

  constructor() {
    this.#server = createServer((request, response) => {
      void this.#handle(request, response);
    });
  }

  async start(): Promise<void> {
    this.#server.listen(0, "127.0.0.1");
    await once(this.#server, "listening");
    this.port = (this.#server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    this.#server.closeAllConnections();
    this.#server.close();
    await once(this.#server, "close");
  }

  url(path: string): string {
    return `http://127.0.0.1:${this.port}${path}`;
  }

  /** every request that is still being served */
  get inFlight(): number {
    return this.#inFlight;
  }

  get completed(): RequestRecord[] {
    return this.requests.filter((request) => request.completed);
  }

  get aborted(): RequestRecord[] {
    return this.requests.filter((request) => request.aborted);
  }

  /** how many requests were started after `at` */
  startedAfter(at: number): RequestRecord[] {
    return this.requests.filter((request) => request.startedAt > at);
  }

  async #handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const url = new URL(request.url ?? "/", `http://localhost`);
    const record: RequestRecord = {
      path: url.pathname,
      startedAt: Date.now(),
      completed: false,
      aborted: false,
    };
    this.requests.push(record);

    this.#inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.#inFlight);

    response.on("close", () => {
      this.#inFlight--;
      record.endedAt = Date.now();
      record.completed = response.writableFinished;
      record.aborted = !response.writableFinished;
    });

    // ?status=500 fails the request outright
    const status = Number(url.searchParams.get("status") ?? "200");
    if (status !== 200) {
      response.writeHead(status, { "content-type": "text/plain" });
      response.end("nope");
      return;
    }

    // ?chunks=n&delay=ms streams the body in n pieces, pausing in between
    const chunks = Number(url.searchParams.get("chunks") ?? "1");
    const delay = Number(url.searchParams.get("delay") ?? "0");
    const body = bodyFor(url.pathname);

    response.writeHead(200, { "content-type": "application/octet-stream" });

    for (let index = 0; index < chunks; index++) {
      if (response.closed) {
        return;
      }
      if (delay > 0) {
        await sleep(delay);
      }
      if (response.closed) {
        return;
      }
      response.write(part(body, index, chunks));
    }

    response.end();
  }
}

/** the body this server serves for a given path */
export function bodyFor(pathname: string): string {
  return `contents of ${pathname}\n`.repeat(8);
}

function part(body: string, index: number, chunks: number): string {
  const size = Math.ceil(body.length / chunks);
  return body.slice(index * size, (index + 1) * size);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
