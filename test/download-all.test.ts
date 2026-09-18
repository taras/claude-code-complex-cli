import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { run } from "effection";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadAll, type Progress } from "../src/download-all.js";
import { bodyFor, sleep, TestServer } from "./server.js";

describe("downloadAll", () => {
  let server: TestServer;
  let destination: string;

  before(async () => {
    server = new TestServer();
    await server.start();
  });

  after(async () => {
    await server.stop();
  });

  beforeEach(async () => {
    destination = await mkdtemp(join(tmpdir(), "downloadall-"));
    server.requests.length = 0;
    server.maxInFlight = 0;
  });

  afterEach(async () => {
    await rm(destination, { recursive: true, force: true });
  });

  it("downloads every file and reports progress as each one completes", async () => {
    const urls = names(12).map((name) => server.url(`/files/${name}`));
    const progress: Progress[] = [];

    await run(() =>
      downloadAll(urls, destination, {
        onProgress: (event) => progress.push(event),
      })
    );

    const files = (await readdir(destination)).sort();
    assert.deepEqual(files, names(12).sort());

    for (const name of names(12)) {
      const contents = await readFile(join(destination, name), "utf8");
      assert.equal(contents, bodyFor(`/files/${name}`));
    }

    assert.equal(progress.length, 12);
    assert.deepEqual(
      progress.map((event) => event.completed),
      Array.from({ length: 12 }, (_, index) => index + 1),
    );
    assert.ok(progress.every((event) => event.total === 12));
    assert.equal(server.completed.length, 12);
  });

  it("never runs more than five downloads at a time", async () => {
    const urls = names(20).map((name) =>
      server.url(`/files/${name}?chunks=4&delay=10`)
    );

    await run(() => downloadAll(urls, destination, { onProgress: () => {} }));

    assert.ok(
      server.maxInFlight <= 5,
      `expected at most 5 concurrent downloads, saw ${server.maxInFlight}`,
    );
    assert.equal(
      server.maxInFlight,
      5,
      `expected the limit to actually be used, saw ${server.maxInFlight}`,
    );
    assert.equal((await readdir(destination)).length, 20);
  });

  it("honours a lower concurrency limit", async () => {
    const urls = names(8).map((name) =>
      server.url(`/files/${name}?chunks=3&delay=10`)
    );

    await run(() =>
      downloadAll(urls, destination, { concurrency: 2, onProgress: () => {} })
    );

    assert.equal(server.maxInFlight, 2);
  });

  it("halts the other downloads when one fails, and leaves nothing behind", async () => {
    const slow = names(9).map((name) =>
      server.url(`/files/${name}?chunks=20&delay=50`)
    );
    const failing = server.url("/files/broken.bin?status=500");
    const urls = [...slow.slice(0, 2), failing, ...slow.slice(2)];

    await assert.rejects(
      run(() => downloadAll(urls, destination, { onProgress: () => {} })),
      /500/,
    );

    assert.deepEqual(await readdir(destination), []);
    assert.ok(
      server.aborted.length > 0,
      "expected the in flight downloads to be aborted",
    );
    assert.equal(server.inFlight, 0, "expected no request still being served");
  });

  it("does no further network or filesystem work once it has shut down", async () => {
    const slow = names(9).map((name) =>
      server.url(`/files/${name}?chunks=20&delay=50`)
    );
    const urls = [
      ...slow.slice(0, 2),
      server.url("/files/broken.bin?status=500"),
      ...slow.slice(2),
    ];

    await assert.rejects(
      run(() => downloadAll(urls, destination, { onProgress: () => {} })),
    );

    const shutdownAt = Date.now();
    const afterShutdown = await readdir(destination);

    await sleep(500);

    assert.deepEqual(
      server.startedAfter(shutdownAt),
      [],
      "expected no request to start after shutdown",
    );
    assert.equal(server.inFlight, 0);
    assert.deepEqual(
      await readdir(destination),
      afterShutdown,
      "expected the destination to stop changing after shutdown",
    );
  });
});

function names(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `file-${index + 1}.bin`);
}
