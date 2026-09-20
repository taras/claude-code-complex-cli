import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type RequestListener, type Server } from "node:http";
import { mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { run } from "effection";

import { downloadAll } from "../src/download-all.ts";

async function startServer(handler: RequestListener): Promise<{
  server: Server;
  origin: string;
}> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

async function stopServer(server: Server): Promise<void> {
  server.closeAllConnections();
  if (!server.listening) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function temporaryDirectory(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "download-all-"));
}

test("downloads every URL and reports progress", async () => {
  const bodies = new Map([
    ["/alpha.txt", "alpha"],
    ["/beta.txt", "beta"],
    ["/gamma.txt", "gamma"],
  ]);
  const { server, origin } = await startServer((request, response) => {
    response.end(bodies.get(request.url ?? "") ?? "missing");
  });
  const destination = await temporaryDirectory();
  const progress: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => progress.push(args.join(" "));

  try {
    await run(() =>
      downloadAll(
        [...bodies.keys()].map((path) => `${origin}${path}`),
        destination,
      )
    );

    for (const [path, expected] of bodies) {
      assert.equal(await readFile(join(destination, path.slice(1)), "utf8"), expected);
    }
    assert(progress.some((line) => line.includes("Downloaded 3/3")));
    assert.deepEqual(
      (await readdir(destination)).sort(),
      ["alpha.txt", "beta.txt", "gamma.txt"],
    );
  } finally {
    console.error = originalError;
    await stopServer(server);
  }
});

test("never runs more than five downloads concurrently", async () => {
  let active = 0;
  let maximum = 0;
  const { server, origin } = await startServer((_request, response) => {
    active += 1;
    maximum = Math.max(maximum, active);
    response.on("close", () => active -= 1);
    response.write("begin");
    setTimeout(() => response.end("end"), 75);
  });
  const destination = await temporaryDirectory();

  try {
    await run(() =>
      downloadAll(
        Array.from({ length: 12 }, (_, index) => `${origin}/file-${index}.txt`),
        destination,
      )
    );
    assert.equal(maximum, 5);
    assert.equal((await readdir(destination)).length, 12);
  } finally {
    await stopServer(server);
  }
});

test("a failure stops active and queued downloads and removes partial files", async () => {
  const requested = new Set<string>();
  let active = 0;
  const { server, origin } = await startServer((request, response) => {
    const url = request.url ?? "";
    requested.add(url);
    active += 1;
    response.on("close", () => active -= 1);

    if (url === "/fail.txt") {
      setTimeout(() => {
        response.statusCode = 500;
        response.end("failure");
      }, 40);
      return;
    }

    response.write("partial");
    const interval = setInterval(() => response.write("more"), 10);
    response.on("close", () => clearInterval(interval));
  });
  const destination = await temporaryDirectory();
  const urls = [
    `${origin}/slow-0.txt`,
    `${origin}/slow-1.txt`,
    `${origin}/slow-2.txt`,
    `${origin}/slow-3.txt`,
    `${origin}/fail.txt`,
    `${origin}/queued-0.txt`,
    `${origin}/queued-1.txt`,
    `${origin}/queued-2.txt`,
  ];

  try {
    await assert.rejects(run(() => downloadAll(urls, destination)), /500/);

    assert.equal(active, 0, "network responses must be closed before rejection");
    assert.equal([...requested].some((url) => url.includes("queued")), false);
    assert.deepEqual(await readdir(destination), []);
  } finally {
    await stopServer(server);
  }
});

test("explicit halt waits for network and filesystem cleanup", async () => {
  let active = 0;
  let writes = 0;
  const requested = new Set<string>();
  const { server, origin } = await startServer((request, response) => {
    requested.add(request.url ?? "");
    active += 1;
    response.on("close", () => active -= 1);
    const interval = setInterval(() => {
      writes += 1;
    }, 10);
    response.on("close", () => clearInterval(interval));
  });
  const destination = await temporaryDirectory();
  const task = run(() =>
    downloadAll(
      Array.from({ length: 8 }, (_, index) => `${origin}/halt-${index}.txt`),
      destination,
    )
  );

  try {
    await waitFor(() => active === 5 && writes > 0, "five active downloads");
    await task.halt();

    assert.equal(active, 0, "network responses must be closed before halt resolves");
    assert.equal(
      [...requested].some((url) => /halt-[5-7]/.test(url)),
      false,
      "queued downloads must not start",
    );
    assert.deepEqual(await readdir(destination), []);

    const snapshot = await stat(destination);
    const writesAtShutdown = writes;
    await new Promise((resolve) => setTimeout(resolve, 75));
    const laterSnapshot = await stat(destination);
    assert.equal(writes, writesAtShutdown, "the server saw activity after shutdown");
    assert.equal(laterSnapshot.mtimeMs, snapshot.mtimeMs, "the directory changed after shutdown");
  } finally {
    await stopServer(server);
  }
});

test("SIGINT stops active and queued CLI work before the process exits", async () => {
  let active = 0;
  let writes = 0;
  const requested = new Set<string>();
  const { server, origin } = await startServer((request, response) => {
    requested.add(request.url ?? "");
    active += 1;
    response.on("close", () => active -= 1);
    response.write("partial");
    const interval = setInterval(() => {
      writes += 1;
      response.write("more");
    }, 10);
    response.on("close", () => clearInterval(interval));
  });
  const destination = await temporaryDirectory();
  const child = spawn(
    process.execPath,
    [
      "--conditions=development",
      "src/cli.ts",
      destination,
      ...Array.from({ length: 8 }, (_, index) => `${origin}/sigint-${index}.txt`),
    ],
    { cwd: process.cwd(), stdio: ["ignore", "ignore", "pipe"] },
  );
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => stderr += chunk);

  try {
    await waitFor(() => active === 5 && writes > 0, "five active CLI downloads");
    assert.equal(child.kill("SIGINT"), true);

    let exitTimeout: NodeJS.Timeout | undefined;
    const result = await Promise.race([
      new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.once("exit", (code, signal) => resolve({ code, signal }));
      }),
      new Promise<never>((_resolve, reject) => {
        exitTimeout = setTimeout(
          () => reject(new Error("CLI did not exit after SIGINT")),
          2_000,
        );
      }),
    ]);
    clearTimeout(exitTimeout);

    assert.deepEqual(result, { code: 130, signal: null }, stderr);
    assert.equal(active, 0, "network responses must be closed before process exit");
    assert.equal(
      [...requested].some((url) => /sigint-[5-7]/.test(url)),
      false,
      "queued downloads must not start",
    );
    assert.deepEqual(await readdir(destination), []);

    const writesAtExit = writes;
    await new Promise((resolve) => setTimeout(resolve, 75));
    assert.equal(writes, writesAtExit, "the server saw activity after process exit");
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    await stopServer(server);
  }
});
