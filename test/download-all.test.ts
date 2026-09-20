import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, sleep, spawn, suspend } from "effection";
import { downloadAll } from "../src/download-all.ts";
import { PARTIAL_CHUNK, startFixture } from "./server.ts";
import type { Fixture } from "./server.ts";

let fixture: Fixture;
let destination: string;

const quiet = () => {};

/** poll until `check` passes, so tests never depend on a fixed delay */
async function until(check: () => Promise<boolean> | boolean, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition never became true");
}

describe("downloadAll", () => {
  before(async () => {
    fixture = await startFixture();
  });

  after(async () => {
    await fixture.close();
  });

  beforeEach(async () => {
    destination = await mkdtemp(join(tmpdir(), "download-all-"));
    fixture.started = 0;
    fixture.peak = 0;
  });

  it("downloads every url into the destination", async () => {
    const urls = ["a", "b", "c"].map((n) => fixture.url(`/file/${n}.txt?body=${n}&repeat=3`));

    await run(function* () {
      yield* downloadAll(urls, destination, quiet);
    });

    assert.deepEqual((await readdir(destination)).sort(), ["a.txt", "b.txt", "c.txt"]);
    assert.equal(await readFile(join(destination, "b.txt"), "utf8"), "bbb");
  });

  it("reports progress while downloads run", async () => {
    const urls = ["a", "b"].map((n) => fixture.url(`/file/${n}.txt?body=${n}`));
    const events: string[] = [];

    await run(function* () {
      yield* downloadAll(urls, destination, (progress) => {
        events.push(progress.type);
      });
    });

    assert.equal(events.filter((e) => e === "start").length, 2);
    assert.equal(events.filter((e) => e === "done").length, 2);
  });

  it("runs no more than five downloads concurrently", async () => {
    const urls = Array.from({ length: 20 }, (_, i) =>
      fixture.url(`/file/c${i}.txt?ms=50&body=x`),
    );

    await run(function* () {
      yield* downloadAll(urls, destination, quiet);
    });

    assert.equal(fixture.peak, 5, "buffer should saturate at exactly five");
    assert.equal((await readdir(destination)).length, 20);
  });

  it("propagates the error and removes partials when one download fails", async () => {
    const urls = [
      ...Array.from({ length: 4 }, (_, i) => fixture.url(`/partial/p${i}.bin`)),
      fixture.url("/fail/boom.txt?ms=150"),
      ...Array.from({ length: 15 }, (_, i) => fixture.url(`/partial/q${i}.bin`)),
    ];

    await assert.rejects(
      run(function* () {
        yield* downloadAll(urls, destination, quiet);
      }),
      /500/,
    );

    assert.equal(fixture.started, 5, "queued work must not start once shutdown begins");
    assert.deepEqual(await readdir(destination), [], "partial files must be removed");
  });

  it("halts all active and queued work, cleaning up partial files", async () => {
    const urls = Array.from({ length: 20 }, (_, i) => fixture.url(`/partial/h${i}.bin`));

    const task = run(function* () {
      yield* spawn(function* () {
        yield* downloadAll(urls, destination, quiet);
      });
      yield* suspend();
    });

    // wait until the five admitted downloads have written their partial chunk
    await until(async () => (await readdir(destination)).length === 5);
    const partial = await readFile(join(destination, "h0.bin"), "utf8");
    assert.equal(partial, PARTIAL_CHUNK);

    await task.halt();

    assert.equal(fixture.started, 5, "queued work must not start once shutdown begins");
    assert.deepEqual(await readdir(destination), [], "partial files must be removed");

    const startedAtShutdown = fixture.started;
    await new Promise((resolve) => setTimeout(resolve, 250));

    assert.equal(fixture.started, startedAtShutdown, "no network activity after shutdown");
    assert.deepEqual(await readdir(destination), [], "no filesystem activity after shutdown");
  });

  it("removes a partial file when the surrounding scope exits normally", async () => {
    const url = fixture.url("/partial/lone.bin");

    await run(function* () {
      yield* spawn(function* () {
        yield* downloadAll([url], destination, quiet);
      });
      // leave the scope while the download is still streaming
      yield* sleep(200);
    });

    assert.deepEqual(await readdir(destination), []);
  });
});

after(async () => {
  await rm(destination, { recursive: true, force: true });
});

describe("shutdown while writes are in flight", () => {
  before(async () => {
    fixture = await startFixture();
  });

  after(async () => {
    await fixture.close();
  });

  beforeEach(async () => {
    destination = await mkdtemp(join(tmpdir(), "download-all-writes-"));
    fixture.started = 0;
    fixture.peak = 0;
  });

  it("drains abandoned writes before removing the partial file", async () => {
    const urls = Array.from({ length: 20 }, (_, i) => fixture.url(`/stream/w${i}.bin`));

    const task = run(function* () {
      yield* spawn(function* () {
        yield* downloadAll(urls, destination, quiet);
      });
      yield* suspend();
    });

    await until(async () => {
      const names = await readdir(destination);
      if (names.length < 5) {
        return false;
      }
      const sizes = await Promise.all(
        names.map(async (n) => (await readFile(join(destination, n))).byteLength),
      );
      return sizes.every((size) => size > 1024 * 1024);
    });

    await task.halt();

    assert.deepEqual(await readdir(destination), [], "partial files must be removed");

    await new Promise((resolve) => setTimeout(resolve, 400));

    assert.deepEqual(await readdir(destination), [], "no write may land after shutdown");
  });
});
