import assert from "node:assert/strict";
import { spawn as spawnProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { run } from "effection";

import { downloadAll, type Progress } from "./download-all.ts";
import { bodyFor, GATE_HEAD, GATE_TAIL, startTestServer, type TestServer } from "./test-server.ts";

const CLI = fileURLToPath(new URL("./cli.ts", import.meta.url));

describe("downloadAll", () => {
  let server: TestServer;
  let destination: string;
  let progress: Progress[];

  let onProgress = (event: Progress) => {
    progress.push(event);
  };

  /** urls that have produced at least one byte, and therefore a partial file. */
  let started = () =>
    new Set(progress.filter((event) => event.type === "data").map((event) => event.url));

  beforeEach(async () => {
    server = await startTestServer();
    destination = await mkdtemp(join(tmpdir(), "download-all-"));
    progress = [];
  });

  // Note: cleanup lives in `afterEach` rather than in a teardown function
  // returned from `beforeEach`. On node v26.5.1 the returned-teardown form
  // leaves the test file pending forever once a test has called `fetch()`.
  afterEach(async () => {
    await server.close();
    await rm(destination, { recursive: true, force: true });
  });

  it("downloads every url into the destination", async () => {
    let paths = ["/file/a.txt", "/file/b.txt", "/file/c.txt", "/file/d.txt", "/file/e.txt", "/file/f.txt"];

    await run(() => downloadAll(paths.map(server.url), destination, { onProgress }));

    assert.deepEqual((await readdir(destination)).sort(), ["a.txt", "b.txt", "c.txt", "d.txt", "e.txt", "f.txt"]);
    for (let path of paths) {
      let name = path.slice("/file/".length);
      assert.equal(await readFile(join(destination, name), "utf8"), bodyFor(path));
    }

    assert.deepEqual(
      progress.filter((event) => event.type === "done").map((event) => event.url).sort(),
      paths.map(server.url).sort(),
      "every download reports completion",
    );
  });

  it("never runs more than five downloads at a time", async () => {
    let urls = Array.from({ length: 12 }, (_, index) => server.url(`/gate/gated-${index}.bin`));

    let task = run(() => downloadAll(urls, destination, { onProgress }));

    await waitFor(() => server.inflight === 5, "five downloads in flight");
    await delay(150);

    assert.equal(server.inflight, 5, "the buffer is saturated, not oversubscribed");
    assert.equal(server.requests.length, 5, "the other seven requests have not been sent");

    server.release();
    await task;

    assert.equal(server.peakInflight, 5);
    assert.equal(server.requests.length, 12);
    assert.equal((await readdir(destination)).length, 12);
    assert.equal(
      await readFile(join(destination, "gated-11.bin"), "utf8"),
      GATE_HEAD + GATE_TAIL,
    );
  });

  it("stops the remaining work and propagates the error when one download fails", async () => {
    // With a limit of five, the first four gated downloads and the failing one
    // are active; the remaining six are queued behind them.
    let urls = [
      ...Array.from({ length: 4 }, (_, index) => server.url(`/gate/active-${index}.bin`)),
      server.url("/hold-fail/boom.bin"),
      ...Array.from({ length: 6 }, (_, index) => server.url(`/gate/queued-${index}.bin`)),
    ];

    let task = run(() => downloadAll(urls, destination, { onProgress }));

    await waitFor(() => started().size === 4, "four partial downloads underway");
    assert.equal((await readdir(destination)).length, 4, "partial files exist on disk");

    let requestsBeforeFailure = server.requests.length;
    server.fail();

    await assert.rejects(task, /500/);

    assert.deepEqual(await readdir(destination), [], "partial files were removed");
    assert.equal(server.requests.length, requestsBeforeFailure, "queued downloads never started");
    assert.equal(server.requests.length, 5);
    await waitFor(() => server.inflight === 0, "in-flight requests were aborted");
  });

  it("halting stops active and queued work, and removes partial files", async () => {
    let urls = Array.from({ length: 12 }, (_, index) => server.url(`/gate/halted-${index}.bin`));

    let task = run(() => downloadAll(urls, destination, { onProgress }));

    await waitFor(() => started().size === 5, "five partial downloads underway");
    assert.equal((await readdir(destination)).length, 5, "partial files exist on disk");

    await task.halt();

    assert.deepEqual(await readdir(destination), [], "partial files were removed");
    assert.equal(server.requests.length, 5, "queued downloads never started");
  });

  it("does no network or filesystem work after shutdown completes", async () => {
    let urls = Array.from({ length: 12 }, (_, index) => server.url(`/gate/quiet-${index}.bin`));

    let task = run(() => downloadAll(urls, destination, { onProgress }));

    await waitFor(() => started().size === 5, "five partial downloads underway");

    await task.halt();

    let requests = [...server.requests];
    let listing = await readdir(destination);
    let events = progress.length;

    await delay(250);

    assert.deepEqual([...server.requests], requests, "no request was sent after shutdown");
    assert.deepEqual(await readdir(destination), listing, "nothing was written after shutdown");
    assert.deepEqual(listing, []);
    assert.equal(progress.length, events, "no progress was reported after shutdown");
    await waitFor(() => server.inflight === 0, "the server saw every connection close");
  });

  it("shuts down cleanly on CTRL-C", async () => {
    let urls = Array.from({ length: 12 }, (_, index) => server.url(`/gate/sigint-${index}.bin`));

    let child = spawnProcess(
      process.execPath,
      ["--conditions=development", CLI, destination, ...urls],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    child.stderr.resume();

    await waitFor(async () => (await readdir(destination)).length === 5, "five partial files on disk");

    child.kill("SIGINT");
    let [code, signal] = (await once(child, "exit")) as [number | null, string | null];

    assert.deepEqual(await readdir(destination), [], "partial files were removed");
    // 130 is the conventional "terminated by SIGINT" status.
    assert.ok(
      code === 0 || code === 130 || signal === "SIGINT",
      `unexpected exit: code=${code} signal=${signal}`,
    );
  });
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  what: string,
  timeout = 5000,
): Promise<void> {
  let deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await delay(10);
  }
  throw new Error(`timed out waiting for ${what}`);
}
