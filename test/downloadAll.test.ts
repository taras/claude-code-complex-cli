import assert from "node:assert/strict";
import { spawn as spawnProcess } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { after, before, test } from "node:test";

import { run } from "effection";

import { downloadAllOperation } from "../src/downloadAll.ts";
import { startTestServer, type TestServer } from "./server.ts";

async function tempDestination(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "download-all-"));
}

let server: TestServer;

before(async () => {
  server = await startTestServer({
    "/small-a": { chunkCount: 1, chunkBytes: 256 },
    "/small-b": { chunkCount: 1, chunkBytes: 256 },
    "/small-c": { chunkCount: 1, chunkBytes: 256 },
    "/fail": { status: 500 },
    ...Object.fromEntries(
      Array.from({ length: 8 }, (_, i) => [
        `/slow-${i}`,
        { chunkCount: 5, chunkBytes: 4096, chunkDelayMs: 60 },
      ]),
    ),
  });
});

after(async () => {
  await server.close();
});

test("downloads every url into the destination", async () => {
  const destination = await tempDestination();
  const urls = ["/small-a", "/small-b", "/small-c"].map((p) => `${server.url}${p}`);

  await run(() => downloadAllOperation(urls, destination));

  const files = await readdir(destination);
  assert.strictEqual(files.length, 3);
  for (const file of files) {
    const content = await readFile(join(destination, file));
    assert.strictEqual(content.length, 256);
  }

  await rm(destination, { recursive: true, force: true });
});

test("runs no more than five downloads concurrently", async () => {
  const destination = await tempDestination();
  const urls = Array.from({ length: 8 }, (_, i) => `${server.url}/slow-${i}`);

  const task = run(() => downloadAllOperation(urls, destination));

  let peak = 0;
  const stop = setInterval(() => {
    peak = Math.max(peak, server.activeConnections());
  }, 5);

  await task;
  clearInterval(stop);

  assert.ok(peak <= 5, `observed peak concurrency of ${peak}, expected <= 5`);
  assert.strictEqual(peak, 5, `expected concurrency to reach the cap of 5, observed ${peak}`);

  await rm(destination, { recursive: true, force: true });
});

test("a failure stops active and queued work and propagates", async () => {
  const destination = await tempDestination();
  const urls = [
    ...Array.from({ length: 4 }, (_, i) => `${server.url}/slow-${i}`),
    `${server.url}/fail`,
    ...Array.from({ length: 4 }, (_, i) => `${server.url}/slow-${i + 4}`),
  ];

  await assert.rejects(run(() => downloadAllOperation(urls, destination)));

  // give halted connections a moment to actually close on the server side
  await delay(100);
  assert.strictEqual(server.activeConnections(), 0, "no active connections should remain");

  const remaining = await readdir(destination);
  assert.deepStrictEqual(remaining, [], "no partial files should remain after failure");

  await rm(destination, { recursive: true, force: true });
});

test("explicit halt stops work and removes partial files", async () => {
  const destination = await tempDestination();
  const urls = Array.from({ length: 3 }, (_, i) => `${server.url}/slow-${i}`);

  const task = run(() => downloadAllOperation(urls, destination));

  // let downloads begin, then halt before any of them complete
  await delay(30);
  await task.halt();

  await delay(100);
  assert.strictEqual(server.activeConnections(), 0, "halt should close in-flight connections");

  const remaining = await readdir(destination);
  assert.deepStrictEqual(remaining, [], "halt should remove partial files");

  await rm(destination, { recursive: true, force: true });
});

test("no queued download starts once shutdown has begun", async () => {
  const destination = await tempDestination();
  const paths = Array.from({ length: 8 }, (_, i) => `queue-${i}`);
  const local = await startTestServer(
    Object.fromEntries(paths.map((p) => [`/${p}`, { chunkCount: 5, chunkBytes: 4096, chunkDelayMs: 80 }])),
  );
  const urls = paths.map((p) => `${local.url}/${p}`);

  const task = run(() => downloadAllOperation(urls, destination));

  // only the first 5 should have been admitted into the buffer by now
  await delay(20);
  await task.halt();

  const startedBeforeHalt = paths.filter((p) => local.requestCount(`/${p}`) > 0).length;
  assert.strictEqual(startedBeforeHalt, 5, "exactly the concurrency cap should have started");

  // wait well past when queued items would have started if the guard failed
  await delay(300);
  const startedAfterWaiting = paths.filter((p) => local.requestCount(`/${p}`) > 0).length;
  assert.strictEqual(
    startedAfterWaiting,
    5,
    "no additional queued download should start after shutdown begins",
  );

  await local.close();
  await rm(destination, { recursive: true, force: true });
});

test("real SIGINT stops the CLI, closes connections, and removes partial files", async () => {
  const destination = await tempDestination();
  const paths = Array.from({ length: 6 }, (_, i) => `sig-${i}`);
  const local = await startTestServer(
    Object.fromEntries(paths.map((p) => [`/${p}`, { chunkCount: 10, chunkBytes: 8192, chunkDelayMs: 80 }])),
  );
  const urls = paths.map((p) => `${local.url}/${p}`);

  const child = spawnProcess(
    process.execPath,
    ["--conditions=development", "bin/download-all.ts", destination, ...urls],
    { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
  );

  let stdout = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));

  // wait until downloads are actually in flight before interrupting
  await delay(150);
  assert.ok(local.activeConnections() > 0, "downloads should be active before SIGINT");

  child.kill("SIGINT");

  const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) => {
    child.on("exit", (c, s) => resolve([c, s]));
  });

  assert.notStrictEqual(code, 0, `expected a non-zero/interrupted exit, got code=${code} signal=${signal}`);
  assert.ok(stdout.includes("start:"), "expected progress output before interruption");

  await delay(150);
  assert.strictEqual(local.activeConnections(), 0, "no network activity should remain after shutdown");

  const remaining = await readdir(destination);
  assert.deepStrictEqual(remaining, [], "no partial files should remain after SIGINT");

  await local.close();
  await rm(destination, { recursive: true, force: true });
});
