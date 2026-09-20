import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { startTestServer, type TestServer } from "./server.ts";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

let server: TestServer;
let destination: string;

before(async () => {
  server = await startTestServer();
});

after(async () => {
  await server.close();
});

beforeEach(async () => {
  destination = await mkdtemp(join(tmpdir(), "download-all-sigint-"));
  server.reset();
});

function waitFor(predicate: () => boolean, timeoutMs = 10000): Promise<void> {
  let deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    let poll = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error("timed out waiting for condition"));
        return;
      }
      setTimeout(poll, 20);
    };
    poll();
  });
}

describe("ctrl-c", () => {
  it("shuts down cleanly on a real SIGINT", { timeout: 30000 }, async () => {
    let urls = Array.from({ length: 12 }, (_, i) => server.url(`/hold/f${i}?head=8192`));

    let child: ChildProcess = spawn(
      process.execPath,
      ["--conditions=development", CLI, destination, ...urls],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    let stderr = "";
    child.stderr!.on("data", (chunk) => {
      stderr += String(chunk);
    });

    await waitFor(() => server.active() === 5);
    assert.ok((await readdir(destination)).length > 0, "partial files exist before SIGINT");

    child.kill("SIGINT");

    let [code, signal] = (await once(child, "exit")) as [number | null, string | null];

    assert.deepEqual(await readdir(destination), [], "partial files are removed");
    assert.equal(server.requests.length, 5, "queued downloads never start");
    assert.equal(server.aborted.length, 5, "in-flight requests are aborted");
    assert.equal(server.active(), 0, "no request is still being served");
    assert.ok(
      stderr.includes("start"),
      `progress was reported while downloads ran: ${stderr}`,
    );

    let seen = server.requests.length;
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(server.requests.length, seen, "no network activity after the process exits");
    assert.deepEqual(
      await readdir(destination),
      [],
      "no filesystem activity after the process exits",
    );

    assert.ok(
      code === 0 || signal === "SIGINT" || code === 130,
      `exited on SIGINT (code=${code}, signal=${signal})`,
    );
  });

  it("exits non-zero and cleans up when a download fails", { timeout: 30000 }, async () => {
    let urls = [
      ...Array.from({ length: 4 }, (_, i) => server.url(`/hold/h${i}?head=8192`)),
      server.url("/fail/boom"),
      ...Array.from({ length: 6 }, (_, i) => server.url(`/hold/q${i}`)),
    ];

    let child = spawn(
      process.execPath,
      ["--conditions=development", CLI, destination, ...urls],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    let stderr = "";
    child.stderr!.on("data", (chunk) => {
      stderr += String(chunk);
    });

    let [code] = (await once(child, "exit")) as [number | null, string | null];

    assert.equal(code, 1, "a failed download exits non-zero");
    assert.match(stderr, /\/fail\/boom failed: 500/);
    assert.deepEqual(await readdir(destination), [], "partial files are removed");
    assert.ok(
      server.requests.every((path) => !path.includes("/hold/q")),
      "queued downloads never start",
    );
    assert.equal(server.active(), 0, "no request is still being served");
  });
});
