import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import { run } from "effection";

import { downloadAll } from "../src/download-all.ts";

test("downloads files successfully and prints progress", async () => {
  const directory = await temporaryDirectory();
  const messages: string[] = [];
  const originalLog = console.log;
  const server = await testServer((_request, response, path) => {
    response.end(`contents:${path}`);
  });

  console.log = (message?: unknown) => {
    messages.push(String(message));
  };

  try {
    const urls = ["alpha.txt", "beta.txt", "gamma.txt"].map(
      (name) => `${server.origin}/${name}`,
    );
    await run(() => downloadAll(urls, directory));

    assert.equal(await readFile(join(directory, "alpha.txt"), "utf8"), "contents:/alpha.txt");
    assert.equal(await readFile(join(directory, "beta.txt"), "utf8"), "contents:/beta.txt");
    assert.equal(await readFile(join(directory, "gamma.txt"), "utf8"), "contents:/gamma.txt");
    assert.equal(messages.length, 3);
    assert.match(messages[2]!, /^\[3\/3\] /);
    await assertCleanShutdown(server, directory);
  } finally {
    console.log = originalLog;
    await server.close();
  }
});

test("never runs more than five downloads concurrently", async () => {
  const directory = await temporaryDirectory();
  let active = 0;
  let maximumActive = 0;
  const server = await testServer((_request, response) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);

    response.on("close", () => {
      active -= 1;
    });

    setTimeout(() => response.end("done"), 75);
  });

  try {
    const urls = Array.from(
      { length: 13 },
      (_, index) => `${server.origin}/concurrent-${index}.txt`,
    );
    await run(() => downloadAll(urls, directory));

    assert.equal(maximumActive, 5);
    assert.equal(active, 0);
    assert.equal((await readdir(directory)).length, 13);
    await assertCleanShutdown(server, directory);
  } finally {
    await server.close();
  }
});

test("one failure halts active siblings and removes every partial file", async () => {
  const directory = await temporaryDirectory();
  let active = 0;
  let aborted = 0;
  const intervals = new Set<NodeJS.Timeout>();

  const server = await testServer((_request, response, path) => {
    active += 1;
    let finished = false;

    response.on("finish", () => {
      finished = true;
    });
    response.on("close", () => {
      active -= 1;
      if (!finished) {
        aborted += 1;
      }
    });

    if (path === "/failure.txt") {
      setTimeout(() => {
        response.statusCode = 500;
        response.end("failure");
      }, 75);
      return;
    }

    streamForever(response, server, intervals);
  });

  try {
    const urls = [
      `${server.origin}/slow-a.txt`,
      `${server.origin}/slow-b.txt`,
      `${server.origin}/failure.txt`,
      `${server.origin}/slow-c.txt`,
      `${server.origin}/slow-d.txt`,
      `${server.origin}/never-started.txt`,
    ];

    await assert.rejects(
      run(() => downloadAll(urls, directory)),
      /HTTP 500 Internal Server Error/,
    );

    assert.equal(active, 0);
    assert.ok(aborted >= 4, `expected at least four aborted requests, got ${aborted}`);
    assert.deepEqual(await readdir(directory), []);
    await assertCleanShutdown(server, directory);
  } finally {
    for (const interval of intervals) {
      clearInterval(interval);
    }
    await server.close();
  }
});

test("Ctrl-C halts active downloads and waits for cleanup", async () => {
  const directory = await temporaryDirectory();
  let active = 0;
  let started = 0;
  let markReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  const intervals = new Set<NodeJS.Timeout>();

  const server = await testServer((_request, response) => {
    active += 1;
    started += 1;
    if (started === 5) {
      markReady();
    }
    response.on("close", () => {
      active -= 1;
    });
    streamForever(response, server, intervals);
  });

  const urls = Array.from(
    { length: 8 },
    (_, index) => `${server.origin}/interrupt-${index}.txt`,
  );
  const child = spawn(
    process.execPath,
    [join(process.cwd(), "src/cli.ts"), directory, ...urls],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  try {
    await Promise.race([
      ready,
      delay(5_000, undefined, { ref: false }).then(() => {
        throw new Error(`downloads did not start in time; stderr: ${stderr}`);
      }),
    ]);

    assert.equal(child.kill("SIGINT"), true);
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => resolve({ code, signal }));
      },
    );

    assert.equal(result.signal, null);
    assert.equal(result.code, 130);
    assert.equal(active, 0);
    assert.deepEqual(await readdir(directory), []);
    await assertCleanShutdown(server, directory);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    for (const interval of intervals) {
      clearInterval(interval);
    }
    await server.close();
  }
});

interface TestServer {
  origin: string;
  bytesSent: number;
  close(): Promise<void>;
}

async function testServer(
  handler: (
    request: IncomingMessage,
    response: ServerResponse,
    path: string,
  ) => void,
): Promise<TestServer> {
  const metrics: TestServer = {
    origin: "",
    bytesSent: 0,
    close: async () => {},
  };
  const server = createServer((request, response) => {
    handler(request, response, new URL(request.url!, "http://localhost").pathname);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  assert.ok(address && typeof address !== "string");
  metrics.origin = `http://127.0.0.1:${address.port}`;
  metrics.close = () =>
    new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
  return metrics;
}

function streamForever(
  response: ServerResponse,
  metrics: TestServer,
  intervals: Set<NodeJS.Timeout>,
): void {
  response.writeHead(200, { "content-type": "application/octet-stream" });
  const chunk = Buffer.alloc(16 * 1024, "x");
  const interval = setInterval(() => {
    if (!response.destroyed) {
      response.write(chunk);
      metrics.bytesSent += chunk.length;
    }
  }, 10);
  intervals.add(interval);
  response.on("close", () => {
    clearInterval(interval);
    intervals.delete(interval);
  });
}

async function temporaryDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), "effection-downloads-"));
}

async function assertCleanShutdown(
  server: TestServer,
  directory: string,
): Promise<void> {
  const bytesAtShutdown = server.bytesSent;
  const snapshot = await directorySnapshot(directory);
  assert.equal(snapshot.some(([name]) => name.endsWith(".part")), false);

  await delay(150);

  assert.equal(server.bytesSent, bytesAtShutdown, "network writes continued after shutdown");
  assert.deepEqual(
    await directorySnapshot(directory),
    snapshot,
    "filesystem state changed after shutdown",
  );
}

async function directorySnapshot(
  directory: string,
): Promise<Array<[string, number, number]>> {
  const names = (await readdir(directory)).sort();
  return Promise.all(
    names.map(async (name) => {
      const metadata = await stat(join(directory, name));
      return [name, metadata.size, metadata.mtimeMs];
    }),
  );
}
