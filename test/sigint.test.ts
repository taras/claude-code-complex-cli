import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startFixture } from "./server.ts";
import type { Fixture } from "./server.ts";

let fixture: Fixture;

before(async () => {
  fixture = await startFixture();
});

after(async () => {
  await fixture.close();
});

test("ctrl-c stops all active and queued work and removes partial files", async () => {
  const destination = await mkdtemp(join(tmpdir(), "download-all-sigint-"));
  const subject = fileURLToPath(new URL("./sigint-subject.ts", import.meta.url));

  const child = spawn(
    process.execPath,
    ["--conditions=development", subject, fixture.url(""), destination],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  let stdout = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });

  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });

  const deadline = Date.now() + 10_000;
  while ((await readdir(destination)).length < 5) {
    assert.ok(Date.now() < deadline, "downloads never started");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  const startedAtSignal = fixture.started;
  child.kill("SIGINT");

  const outcome = await exited;

  assert.equal(fixture.started, startedAtSignal, "no queued work started after SIGINT");
  assert.deepEqual(await readdir(destination), [], "partial files must be removed");
  assert.equal(stdout.match(/↓/g)?.length, 5, "only the admitted five ever started");

  await new Promise((resolve) => setTimeout(resolve, 300));

  assert.equal(fixture.started, startedAtSignal, "no network activity after shutdown");
  assert.deepEqual(await readdir(destination), [], "no filesystem activity after shutdown");

  console.log(`  ℹ child exited code=${outcome.code} signal=${outcome.signal}`);
});
