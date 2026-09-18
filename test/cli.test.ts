import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readdirSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { bodyFor, sleep, TestServer } from "./server.js";

const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));

describe("downloadall cli", () => {
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
    destination = await mkdtemp(join(tmpdir(), "downloadall-cli-"));
    server.requests.length = 0;
    server.maxInFlight = 0;
  });

  afterEach(async () => {
    await rm(destination, { recursive: true, force: true });
  });

  it("downloads everything it is given", async () => {
    const urls = [1, 2, 3].map((n) => server.url(`/files/file-${n}.bin`));
    const { code, stdout } = await runCli([destination, ...urls]);

    assert.equal(code, 0);
    assert.match(stdout, /\[3\/3\]/);
    assert.deepEqual((await readdir(destination)).sort(), [
      "file-1.bin",
      "file-2.bin",
      "file-3.bin",
    ]);
  });

  it("stops every download on ctrl-c and deletes the partial files before it exits", async () => {
    const fast = [1, 2, 3].map((n) => server.url(`/files/fast-${n}.bin`));
    const slow = [1, 2, 3, 4, 5, 6, 7, 8].map((n) =>
      server.url(`/files/slow-${n}.bin?chunks=40&delay=50`)
    );

    const child = spawn(process.execPath, [cli, destination, ...fast, ...slow], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => stdout += chunk);
    child.stderr.setEncoding("utf8").on("data", (chunk) => stderr += chunk);

    // snapshot the destination the instant the process is gone, so that the
    // assertions below are about what was true *before* it exited.
    let atExit: string[] = [];
    child.on("exit", () => {
      atExit = readdirSync(destination);
    });

    // wait until the three fast files are done and the slow ones have started
    // landing partial bytes on disk
    await waitFor(() =>
      stdout.includes("[3/11]") &&
      readdirSync(destination).some((name) => name.startsWith("slow-"))
    );
    const partials = readdirSync(destination);

    child.kill("SIGINT");
    const [code, signal] = await once(child, "exit");

    assert.ok(
      partials.some((name) => name.startsWith("slow-")),
      `expected partially written files while downloading, saw ${partials}`,
    );

    assert.deepEqual(
      atExit.sort(),
      ["fast-1.bin", "fast-2.bin", "fast-3.bin"],
      "expected the partial files to be deleted before the process exited",
    );

    for (const name of atExit) {
      const contents = await readFile(join(destination, name), "utf8");
      assert.equal(contents, bodyFor(`/files/${name}`));
    }

    assert.ok(server.aborted.length > 0, "expected in flight requests to be aborted");
    assert.equal(server.inFlight, 0, "expected the server to be idle");
    assert.doesNotMatch(stderr, /Error/);

    const exitedAt = Date.now();
    await sleep(500);
    assert.deepEqual(server.startedAfter(exitedAt), []);
    assert.deepEqual(await readdir(destination), atExit);

    // 130 is the conventional exit code for a process ended by SIGINT: the
    // signal handler main() installs halted the program rather than killing it.
    assert.equal(code, 130);
    assert.equal(signal, null);
  });

  it("fails with a non zero exit code when a download fails", async () => {
    const urls = [
      server.url("/files/ok.bin?chunks=10&delay=30"),
      server.url("/files/broken.bin?status=500"),
      server.url("/files/other.bin?chunks=10&delay=30"),
    ];

    const { code, stderr } = await runCli([destination, ...urls]);

    assert.notEqual(code, 0);
    assert.match(stderr, /500/);
    assert.deepEqual(await readdir(destination), []);
  });
});

async function runCli(
  args: string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [cli, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => stdout += chunk);
  child.stderr.setEncoding("utf8").on("data", (chunk) => stderr += chunk);

  const [code] = await once(child, "exit");
  return { code, stdout, stderr };
}

async function waitFor(condition: () => boolean, timeout = 10_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error("timed out waiting for condition");
    }
    await sleep(10);
  }
}
