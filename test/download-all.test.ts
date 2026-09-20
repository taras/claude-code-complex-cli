import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, sleep, spawn, suspend, type Task } from "effection";

import { downloadAll, type DownloadEvent } from "../src/download-all.ts";
import { startTestServer, type TestServer } from "./server.ts";

let server: TestServer;
let destination: string;

before(async () => {
  server = await startTestServer();
});

after(async () => {
  await server.close();
});

beforeEach(async () => {
  destination = await mkdtemp(join(tmpdir(), "download-all-"));
  server.reset();
});

function silent(): (event: DownloadEvent) => void {
  return () => {};
}

async function settle(ms = 150): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe("downloadAll", () => {
  it("downloads every url into the destination", { timeout: 20000 }, async () => {
    let urls = ["a", "b", "c"].map((name) => server.url(`/instant/${name}`));

    await run(() => downloadAll(urls, destination, { onProgress: silent() }));

    assert.deepEqual((await readdir(destination)).sort(), ["a", "b", "c"]);
    assert.equal(await readFile(join(destination, "b"), "utf8"), "/instant/b");
  });

  it("reports progress while downloads run", { timeout: 20000 }, async () => {
    let events: DownloadEvent[] = [];
    let urls = ["a", "b"].map((name) => server.url(`/instant/${name}`));

    await run(() =>
      downloadAll(urls, destination, { onProgress: (event) => events.push(event) })
    );

    let starts = events.filter((event) => event.type === "start");
    let completes = events.filter((event) => event.type === "complete");

    assert.equal(starts.length, 2);
    assert.equal(completes.length, 2);
    assert.ok(events.some((event) => event.type === "progress"));
    for (let event of completes) {
      assert.ok(event.bytes > 0);
    }
  });

  it("runs no more than five downloads concurrently", { timeout: 20000 }, async () => {
    let urls = Array.from({ length: 12 }, (_, i) => server.url(`/hold/f${i}`));

    await run(function* () {
      let task: Task<void> = yield* spawn(() =>
        downloadAll(urls, destination, { onProgress: silent() })
      );

      yield* sleep(200);
      assert.equal(server.requests.length, 5, "only five requests are ever in flight");
      assert.equal(server.active(), 5);

      server.release();
      yield* task;
    });

    assert.equal(server.maxActive, 5);
    assert.equal(server.requests.length, 12);
    assert.equal((await readdir(destination)).length, 12);
  });

  it("stops active and queued work and propagates the error when one download fails", { timeout: 20000 }, async () => {
    let urls = [
      ...Array.from({ length: 4 }, (_, i) => server.url(`/hold/h${i}`)),
      server.url("/fail/boom"),
      ...Array.from({ length: 6 }, (_, i) => server.url(`/hold/q${i}`)),
    ];

    let error = await run(function* () {
      try {
        yield* downloadAll(urls, destination, { onProgress: silent() });
        return undefined;
      } catch (caught) {
        return caught as Error;
      }
    });

    assert.ok(error, "downloadAll propagates the failure");
    assert.match(error.message, /\/fail\/boom failed: 500/);

    assert.equal(server.requests.length, 5, "queued downloads never start");
    assert.ok(server.requests.every((path) => !path.includes("/hold/q")));

    assert.deepEqual(await readdir(destination), [], "partial files are removed");

    let seen = server.requests.length;
    await settle();
    assert.equal(server.requests.length, seen, "no network activity after shutdown");
    assert.deepEqual(await readdir(destination), [], "no filesystem activity after shutdown");
  });

  it("removes partial files and stops queued work on explicit halt", { timeout: 20000 }, async () => {
    let urls = Array.from({ length: 12 }, (_, i) => server.url(`/hold/f${i}?head=4096`));
    let task = run(() => downloadAll(urls, destination, { onProgress: silent() }));

    await settle(200);
    assert.equal(server.requests.length, 5);
    assert.ok((await readdir(destination)).length > 0, "partial files exist before halt");

    await task.halt();

    assert.deepEqual(await readdir(destination), [], "partial files are removed");
    assert.equal(server.requests.length, 5, "queued downloads never start");
    assert.equal(server.aborted.length, 5, "in-flight requests are aborted");

    await settle();
    assert.equal(server.requests.length, 5, "no network activity after shutdown");
    assert.equal(server.active(), 0, "no request is still being served");
    assert.deepEqual(await readdir(destination), [], "no filesystem activity after shutdown");
  });

  it("keeps completed files when a later download is halted", { timeout: 20000 }, async () => {
    let urls = [
      server.url("/instant/keep"),
      server.url("/hold/pending"),
    ];

    let task = run(function* () {
      yield* spawn(() => downloadAll(urls, destination, { onProgress: silent() }));
      yield* suspend();
    });

    await settle(200);
    await task.halt();

    assert.deepEqual(await readdir(destination), ["keep"]);
  });

  it("leaves no open descriptors behind when halted repeatedly", { timeout: 30000 }, async () => {
    let urls = Array.from({ length: 10 }, (_, i) => server.url(`/hold/f${i}?head=4096`));

    let openDescriptors = () => readdirSync("/dev/fd").length;
    let baseline = 0;

    for (let attempt = 0; attempt < 8; attempt++) {
      let task = run(() => downloadAll(urls, destination, { onProgress: silent() }));
      await settle(60);
      await task.halt();

      assert.deepEqual(await readdir(destination), []);

      if (attempt === 2) {
        baseline = openDescriptors();
      }
      if (attempt > 2) {
        assert.ok(
          openDescriptors() <= baseline,
          `descriptor count grew from ${baseline} to ${openDescriptors()}`,
        );
      }
      server.reset();
    }
  });

  it("rejects an invalid url before doing any work", { timeout: 20000 }, async () => {
    await assert.rejects(
      run(() => downloadAll(["not a url"], destination, { onProgress: silent() })),
      /Invalid URL/,
    );
    assert.deepEqual(await readdir(destination), []);
  });
});

after(async () => {
  await rm(destination, { recursive: true, force: true });
});
