import assert from "node:assert/strict";
import { spawn as spawnProcess } from "node:child_process";
import { once } from "node:events";
import { readdir, readFile, rm } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { run } from "effection";

import { downloadAll } from "../src/download-all.ts";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const { mkdtemp } = await import("node:fs/promises");
  const directory = await mkdtemp(join(tmpdir(), "download-all-"));
  temporaryDirectories.push(directory);
  return directory;
}

test.after(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function listen(
  handler: (path: string, response: ServerResponse) => void,
): Promise<{
  baseUrl: string;
  close(): Promise<void>;
}> {
  const server: Server = createServer((request, response) => {
    handler(new URL(request.url ?? "/", "http://localhost").pathname, response);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      server.close();
      await once(server, "close");
    },
  };
}

async function waitFor(predicate: () => boolean, timeout = 2_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("downloads every URL, reports progress, and never exceeds five active downloads", async () => {
  const destination = await temporaryDirectory();
  let active = 0;
  let maximumActive = 0;
  const server = await listen((path, response) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    response.on("close", () => {
      active -= 1;
    });
    setTimeout(() => response.end(`contents:${path}`), 40);
  });
  const messages: string[] = [];
  const originalError = console.error;
  console.error = (...values: unknown[]) => messages.push(values.join(" "));

  try {
    const urls = Array.from(
      { length: 9 },
      (_, index) => `${server.baseUrl}/file-${index}.txt`,
    );
    await run(() => downloadAll(urls, destination));

    assert.equal(maximumActive, 5);
    assert.equal(active, 0);
    assert.equal((await readdir(destination)).length, 9);
    assert.equal(
      await readFile(join(destination, "file-7.txt"), "utf8"),
      "contents:/file-7.txt",
    );
    assert(messages.some((message) => message.startsWith("[download]")));
    assert.equal((await readdir(destination)).some((name) => name.endsWith(".part")), false);
  } finally {
    console.error = originalError;
    await server.close();
  }
});

test("a failure stops active and queued work, removes partials, and waits for shutdown", async () => {
  const destination = await temporaryDirectory();
  const started: string[] = [];
  const active = new Set<string>();
  let shutdownBegan = false;
  const startedAfterShutdown: string[] = [];
  const intervals = new Set<NodeJS.Timeout>();
  const server = await listen((path, response) => {
    started.push(path);
    active.add(path);
    if (shutdownBegan) startedAfterShutdown.push(path);
    response.on("close", () => active.delete(path));

    if (path === "/fail.txt") {
      setTimeout(() => {
        shutdownBegan = true;
        response.writeHead(500).end("failure");
      }, 50);
      return;
    }

    const interval = setInterval(() => response.write("data"), 10);
    intervals.add(interval);
    response.on("close", () => {
      clearInterval(interval);
      intervals.delete(interval);
    });
  });

  try {
    const urls = [
      `${server.baseUrl}/fail.txt`,
      ...Array.from(
        { length: 8 },
        (_, index) => `${server.baseUrl}/slow-${index}.txt`,
      ),
    ];
    await assert.rejects(
      run(() => downloadAll(urls, destination)),
      /500 Internal Server Error/,
    );

    assert.equal(started.length, 5);
    assert.deepEqual(startedAfterShutdown, []);
    assert.equal(active.size, 0);
    assert.equal(intervals.size, 0);
    assert.equal((await readdir(destination)).some((name) => name.endsWith(".part")), false);

    const snapshot = await readdir(destination);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(await readdir(destination), snapshot);
    assert.equal(started.length, 5);
  } finally {
    for (const interval of intervals) clearInterval(interval);
    await server.close();
  }
});

test("an explicit halt stops all work and completes cleanup before halt resolves", async () => {
  const destination = await temporaryDirectory();
  const started: string[] = [];
  const active = new Set<string>();
  const intervals = new Set<NodeJS.Timeout>();
  const server = await listen((path, response) => {
    started.push(path);
    active.add(path);
    response.on("close", () => active.delete(path));
    const interval = setInterval(() => response.write("data"), 10);
    intervals.add(interval);
    response.on("close", () => {
      clearInterval(interval);
      intervals.delete(interval);
    });
  });

  try {
    const urls = Array.from(
      { length: 9 },
      (_, index) => `${server.baseUrl}/halt-${index}.txt`,
    );
    const task = run(() => downloadAll(urls, destination));
    await waitFor(() => started.length === 5);
    await task.halt();

    assert.equal(started.length, 5);
    assert.equal(active.size, 0);
    assert.equal(intervals.size, 0);
    assert.equal((await readdir(destination)).some((name) => name.endsWith(".part")), false);
    await assert.rejects(task, /halted/);
  } finally {
    for (const interval of intervals) clearInterval(interval);
    await server.close();
  }
});

test("SIGINT performs orderly cancellation and cleanup before the CLI exits", async () => {
  const destination = await temporaryDirectory();
  const started: string[] = [];
  const active = new Set<string>();
  const intervals = new Set<NodeJS.Timeout>();
  const server = await listen((path, response) => {
    started.push(path);
    active.add(path);
    response.on("close", () => active.delete(path));
    const interval = setInterval(() => response.write("data"), 10);
    intervals.add(interval);
    response.on("close", () => {
      clearInterval(interval);
      intervals.delete(interval);
    });
  });

  try {
    const cli = resolve("src/download-all.ts");
    const urls = Array.from(
      { length: 9 },
      (_, index) => `${server.baseUrl}/sigint-${index}.txt`,
    );
    const child = spawnProcess(
      process.execPath,
      ["--conditions=development", cli, destination, ...urls],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    await waitFor(() => started.length === 5);
    child.kill("SIGINT");
    const [code, signal] = (await once(child, "close")) as [
      number | null,
      NodeJS.Signals | null,
    ];

    assert.equal(code, 130, stderr);
    assert.equal(signal, null);
    assert.equal(started.length, 5);
    assert.equal(active.size, 0);
    assert.equal(intervals.size, 0);
    assert.equal((await readdir(destination)).some((name) => name.endsWith(".part")), false);
  } finally {
    for (const interval of intervals) clearInterval(interval);
    await server.close();
  }
});
