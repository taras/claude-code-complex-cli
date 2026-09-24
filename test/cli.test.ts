import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { startServer, type TestServer } from "./server.ts";

const CLI = new URL("../src/cli.ts", import.meta.url).pathname;

describe("cli", () => {
  let server: TestServer;
  let dest: string;

  before(async () => {
    server = await startServer();
  });
  after(async () => {
    await server.close();
  });
  beforeEach(async () => {
    dest = await mkdtemp(join(tmpdir(), "download-cli-"));
  });

  it("downloads files and reports progress", async () => {
    let urls = ["a", "b", "c"].map((n) => server.url(`/file/${n}`));
    let child = spawn(process.execPath, [CLI, dest, ...urls], { stdio: ["ignore", "pipe", "pipe"] });

    let out = "";
    child.stdout.on("data", (d) => (out += d));
    let [code] = await once(child, "exit");

    assert.equal(code, 0);
    assert.equal((await readdir(dest)).length, 3);
    assert.match(out, /\[3\/3\]/);
    assert.match(out, /downloaded 3 files/);
  });

  it("shuts down cleanly on SIGINT, leaving no partial files", async () => {
    let urls = Array.from(
      { length: 12 },
      (_, i) => server.url(`/file/sigint-${i}?chunks=60&delay=30`),
    );
    let startedBefore = server.started.length;

    let child = spawn(process.execPath, [CLI, dest, ...urls], { stdio: ["ignore", "pipe", "pipe"] });
    await once(child, "spawn");

    // Wait until downloads are genuinely in flight and partially written.
    let partials: string[] = [];
    for (let i = 0; i < 100 && partials.length === 0; i++) {
      await delay(25);
      partials = await readdir(dest);
    }
    assert.equal(partials.length > 0, true, "expected partial files before interrupting");
    assert.equal(server.inflight > 0, true, "expected requests in flight before interrupting");

    child.kill("SIGINT");
    let [code, signal] = await once(child, "exit");

    // Checked at the instant the process exits: if the process had exited while
    // cleanup was still running, the partial files would still be here.
    assert.deepEqual(await readdir(dest), [], "partial files must be gone when the process exits");
    assert.equal(signal === "SIGINT" || code !== null, true);

    let startedAtExit = server.started.length;
    await delay(300);

    assert.equal(server.inflight, 0, "no request may still be in flight after exit");
    assert.equal(server.started.length, startedAtExit, "no request may start after exit");
    assert.deepEqual(await readdir(dest), [], "no file may reappear after exit");
    assert.equal(server.aborted.length > 0, true, "in-flight requests should have been aborted");
  });
});
