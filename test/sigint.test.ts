import assert from "node:assert/strict";
import { type ChildProcess, spawn as spawnProcess } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { beforeEach, describe, it } from "@effectionx/bdd";
import { call, each, ensure, type Operation, resource, sleep } from "effection";
import { on, once } from "@effectionx/node/events";
import { MAX_CONCURRENT_DOWNLOADS } from "../src/download-all.ts";
import { type TestServer, useServer } from "./server.ts";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

describe("download-all cli", () => {
  let server: TestServer;
  let destination: string;

  beforeEach(function* () {
    server = yield* useServer();
    destination = yield* call(() => mkdtemp(join(tmpdir(), "download-all-")));
    yield* ensure(function* () {
      yield* call(() => rm(destination, { recursive: true, force: true }));
    });
  });

  it("shuts down cleanly on SIGINT", function* () {
    let names = ["a", "b", "c", "d", "e", "f", "g", "h"];
    let child = yield* useCli([
      destination,
      ...names.map((n) => server.url(`/hang/${n}`)),
    ]);

    // wait until downloads are actually running before interrupting
    for (let [chunk] of yield* each(on<[Buffer]>(child.stderr!, "data"))) {
      if (String(chunk).includes("start")) {
        break;
      }
      yield* each.next();
    }
    yield* sleep(150);

    assert.equal(
      (yield* call(() => readdir(destination))).length,
      MAX_CONCURRENT_DOWNLOADS,
      "expected partial files before SIGINT",
    );

    let startedBeforeSignal = server.stats.started.length;
    child.kill("SIGINT");

    let [code, signal] = yield* once<[number | null, string | null]>(
      child,
      "exit",
    );

    assert.equal(signal, null, "process died from the signal instead of exiting");
    assert.notEqual(code, null);

    assert.deepEqual(
      yield* call(() => readdir(destination)),
      [],
      "partial files survived SIGINT",
    );

    yield* sleep(300);

    assert.equal(
      server.stats.started.length,
      startedBeforeSignal,
      "queued work started after SIGINT",
    );
    assert.ok(server.stats.started.length <= MAX_CONCURRENT_DOWNLOADS);
    assert.equal(server.stats.active, 0, "server still has requests in flight");
    assert.deepEqual(yield* call(() => readdir(destination)), []);
  });
});

function useCli(args: string[]): Operation<ChildProcess> {
  return resource(function* (provide) {
    let child = spawnProcess(
      process.execPath,
      ["--conditions=development", CLI, ...args],
      { stdio: ["ignore", "ignore", "pipe"] },
    );

    yield* ensure(function* () {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        yield* once(child, "exit");
      }
    });

    yield* provide(child);
  });
}
