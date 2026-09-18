import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { run, sleep, spawn, until } from "effection";
import { downloadAll } from "../src/download-all.ts";
import { expectedBody, startServer, type TestServer } from "./server.ts";

describe("downloadAll", () => {
  let server: TestServer;
  let dest: string;

  before(async () => {
    server = await startServer();
  });
  after(async () => {
    await server.close();
  });
  beforeEach(async () => {
    dest = await mkdtemp(join(tmpdir(), "download-all-"));
  });

  it("downloads every file", async () => {
    let names = ["a", "b", "c", "d", "e", "f", "g"];
    let urls = names.map((n) => server.url(`/file/${n}`));
    let progress: number[] = [];

    let paths = await run(() =>
      downloadAll(urls, dest, {
        onProgress: ({ completed }) => progress.push(completed),
      })
    );

    assert.equal(paths.length, names.length);
    for (let [index, name] of names.entries()) {
      assert.equal(await readFile(paths[index], "utf8"), expectedBody(name));
    }
    assert.deepEqual(progress.sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7]);
  });

  it("never exceeds the concurrency limit", async () => {
    let urls = Array.from({ length: 30 }, (_, i) => server.url(`/file/n${i}?chunks=3&delay=10`));

    await run(() => downloadAll(urls, dest, { onProgress: () => {} }));

    assert.equal(server.maxInflight <= 5, true, `maxInflight was ${server.maxInflight}`);
    assert.equal(server.maxInflight, 5, "expected the limit to actually be saturated");
  });

  it("propagates a failure and halts the downloads still in flight", async () => {
    let urls = [
      server.url("/file/slow-1?chunks=40&delay=25"),
      server.url("/file/slow-2?chunks=40&delay=25"),
      server.url("/file/slow-3?chunks=40&delay=25"),
      server.url("/file/slow-4?chunks=40&delay=25"),
      server.url("/fail/bad?delay=60"),
    ];

    await assert.rejects(
      run(() => downloadAll(urls, dest, { onProgress: () => {} })),
      /GET .*\/fail\/bad.* failed: 500/,
    );

    assert.deepEqual(await readdir(dest), [], "no partial files should survive the failure");
    assert.equal(server.inflight, 0, "server should see no in-flight requests after failure");
  });

  it("removes partial files and stops work when the enclosing scope is halted", async () => {
    let urls = Array.from(
      { length: 8 },
      (_, i) => server.url(`/file/halt-${i}?chunks=40&delay=25`),
    );

    let startedBefore = server.started.length;

    await run(function* () {
      let task = yield* spawn(() => downloadAll(urls, dest, { onProgress: () => {} }));
      yield* sleep(120);
      // Files are open and partially written at this point.
      assert.equal((yield* until(readdir(dest))).length > 0, true, "expected partial files on disk");
      yield* task.halt();
    });

    assert.deepEqual(await readdir(dest), [], "no partial files should survive the halt");

    let startedAfterHalt = server.started.length;
    let requestsDuringRun = startedAfterHalt - startedBefore;
    assert.equal(requestsDuringRun > 0, true);

    await delay(200);

    assert.equal(server.inflight, 0, "no request should still be in flight");
    assert.equal(server.started.length, startedAfterHalt, "no new requests after shutdown");
    assert.deepEqual(await readdir(dest), [], "no file should reappear after shutdown");
  });

  it("does not queue work that was never reached", async () => {
    let urls = Array.from({ length: 50 }, (_, i) => server.url(`/file/q${i}?chunks=20&delay=25`));
    let startedBefore = server.started.length;

    await run(function* () {
      let task = yield* spawn(() => downloadAll(urls, dest, { onProgress: () => {} }));
      yield* sleep(80);
      yield* task.halt();
    });

    let started = server.started.length - startedBefore;
    assert.equal(started < 50, true, `only the buffered work should have started, got ${started}`);
    assert.deepEqual(await readdir(dest), []);
  });
});
