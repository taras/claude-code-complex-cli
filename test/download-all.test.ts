import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, it } from "@effectionx/bdd";
import { call, ensure, sleep, spawn } from "effection";
import {
  downloadAll,
  MAX_CONCURRENT_DOWNLOADS,
} from "../src/download-all.ts";
import { body, type TestServer, useServer } from "./server.ts";

describe("downloadAll", () => {
  let server: TestServer;
  let destination: string;

  beforeEach(function* () {
    server = yield* useServer();
    destination = yield* useTempDir();
  });

  it("downloads every url into destination", function* () {
    let names = ["a", "b", "c", "d", "e", "f", "g", "h"];

    yield* downloadAll(names.map((n) => server.url(`/fast/${n}`)), destination);

    assert.deepEqual((yield* readDir(destination)).sort(), [...names].sort());

    for (let name of names) {
      let content = yield* readText(join(destination, name));
      assert.equal(content, body(name));
    }
  });

  it("runs at most five downloads concurrently", function* () {
    let names = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"];

    yield* downloadAll(names.map((n) => server.url(`/slow/${n}`)), destination);

    assert.equal((yield* readDir(destination)).length, names.length);
    assert.equal(server.stats.maxActive, MAX_CONCURRENT_DOWNLOADS);
  });

  it("propagates a failure and stops active and queued work", function* () {
    let urls = [
      server.url("/slow/a"),
      server.url("/slow/b"),
      server.url("/faillate/c"),
      ...["d", "e", "f", "g", "h", "i", "j", "k", "l"].map((n) =>
        server.url(`/slow/${n}`)
      ),
    ];

    let partial: string[] = [];
    yield* spawn(function* () {
      yield* sleep(60);
      partial = yield* readDir(destination);
    });

    let error: unknown;
    try {
      yield* downloadAll(urls, destination);
    } catch (e) {
      error = e;
    }

    // the failing url never opens a file, so only the other four actives do
    assert.deepEqual(
      partial,
      ["a", "b", "d", "e"],
      "expected partial files to exist before the failure",
    );

    assert.ok(error instanceof Error, `expected an Error, got ${error}`);
    assert.match(error.message, /failed to download .*\/faillate\/c: 500/);

    assert.deepEqual(
      yield* readDir(destination),
      [],
      "partial files survived the failure",
    );

    yield* assertQuiet(server, destination);

    assert.ok(
      server.stats.started.length <= MAX_CONCURRENT_DOWNLOADS,
      `queued work started after the failure: ${
        server.stats.started.join(", ")
      }`,
    );
  });

  it("removes partial files and stops everything when halted", function* () {
    let names = ["a", "b", "c", "d", "e", "f", "g", "h"];
    let urls = names.map((n) => server.url(`/hang/${n}`));

    let task = yield* spawn(() => downloadAll(urls, destination));

    yield* sleep(150);

    let partial = yield* readDir(destination);
    assert.equal(partial.length, MAX_CONCURRENT_DOWNLOADS);
    for (let name of partial) {
      assert.ok((yield* readText(join(destination, name))).length > 0);
    }

    yield* task.halt();

    assert.deepEqual(
      yield* readDir(destination),
      [],
      "partial files survived the halt",
    );

    yield* assertQuiet(server, destination);

    assert.ok(
      server.stats.started.length <= MAX_CONCURRENT_DOWNLOADS,
      `queued work started after the halt: ${server.stats.started.join(", ")}`,
    );
  });
});

function* assertQuiet(server: TestServer, destination: string) {
  // a request already on the wire when shutdown began can still reach the
  // server afterwards, so let the sockets settle before taking a baseline
  yield* sleep(300);

  let started = server.stats.started.length;
  let entries = yield* readDir(destination);

  assert.equal(server.stats.active, 0, "server still has requests in flight");

  yield* sleep(300);

  assert.equal(server.stats.started.length, started, "network activity continued");
  assert.deepEqual(yield* readDir(destination), entries, "filesystem activity continued");
}

function* readDir(path: string) {
  return (yield* call(() => readdir(path))).sort();
}

function* readText(path: string) {
  return yield* call(() => readFile(path, "utf8"));
}

function* useTempDir() {
  let dir = yield* call(() => mkdtemp(join(tmpdir(), "download-all-")));
  yield* ensure(function* () {
    yield* call(() => rm(dir, { recursive: true, force: true }));
  });
  return dir;
}
