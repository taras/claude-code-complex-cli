import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { run } from "effection";
import { downloadAll } from "../src/download-all.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true })
    ),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "download-all-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function listen(server: Server): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  server.close();
  await once(server, "close");
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("downloads files and reports progress", async () => {
  const destination = await temporaryDirectory();
  const server = createServer((request, response) => {
    response.end(`contents:${request.url}`);
  });
  const origin = await listen(server);
  const progress: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => progress.push(args.join(" "));

  try {
    await run(() =>
      downloadAll(
        [`${origin}/one.txt`, `${origin}/two.txt`, `${origin}/three.txt`],
        destination,
      )
    );
  } finally {
    console.log = originalLog;
    await close(server);
  }

  assert.equal(await readFile(join(destination, "one.txt"), "utf8"), "contents:/one.txt");
  assert.equal(await readFile(join(destination, "two.txt"), "utf8"), "contents:/two.txt");
  assert.equal(await readFile(join(destination, "three.txt"), "utf8"), "contents:/three.txt");
  assert.equal(progress.length, 3);
  assert.deepEqual(
    progress.map((line) => line.match(/\((\d+)\/3\)$/)?.[1]).sort(),
    ["1", "2", "3"],
  );
});

test("never runs more than five downloads concurrently", async () => {
  const destination = await temporaryDirectory();
  let active = 0;
  let maximum = 0;
  const server = createServer((_request, response) => {
    active++;
    maximum = Math.max(maximum, active);
    setTimeout(() => {
      response.end("done");
      active--;
    }, 50);
  });
  const origin = await listen(server);

  try {
    await run(() =>
      downloadAll(
        Array.from({ length: 13 }, (_, index) => `${origin}/file-${index}.txt`),
        destination,
      )
    );
  } finally {
    await close(server);
  }

  assert.equal(maximum, 5);
  assert.equal(active, 0);
  assert.equal((await readdir(destination)).length, 13);
});

test("one failure aborts active siblings and removes partial files", async () => {
  const destination = await temporaryDirectory();
  let active = 0;
  let bytes = 0;
  let requests = 0;
  const intervals = new Set<NodeJS.Timeout>();
  const server = createServer((request, response) => {
    requests++;
    active++;
    response.on("close", () => active--);

    if (request.url === "/failure.txt") {
      setTimeout(() => response.writeHead(500).end("failure"), 40);
      return;
    }

    const interval = setInterval(() => {
      bytes++;
      response.write("x");
    }, 5);
    intervals.add(interval);
    response.on("close", () => {
      clearInterval(interval);
      intervals.delete(interval);
    });
  });
  const origin = await listen(server);
  const urls = [
    `${origin}/slow-1.txt`,
    `${origin}/slow-2.txt`,
    `${origin}/slow-3.txt`,
    `${origin}/slow-4.txt`,
    `${origin}/failure.txt`,
    `${origin}/never-started.txt`,
  ];

  try {
    await assert.rejects(run(() => downloadAll(urls, destination)), /500/);
    const bytesAtShutdown = bytes;
    assert.equal(active, 0);
    assert.equal(intervals.size, 0);
    assert.equal(requests, 5);
    assert.deepEqual(await readdir(destination), []);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(bytes, bytesAtShutdown);
    assert.deepEqual(await readdir(destination), []);
  } finally {
    for (const interval of intervals) {
      clearInterval(interval);
    }
    await close(server);
  }
});

test("Ctrl-C waits for active downloads and partial-file cleanup", async () => {
  const destination = await temporaryDirectory();
  let active = 0;
  let bytes = 0;
  const intervals = new Set<NodeJS.Timeout>();
  const server = createServer((_request, response) => {
    active++;
    const interval = setInterval(() => {
      bytes++;
      response.write("x");
    }, 5);
    intervals.add(interval);
    response.on("close", () => {
      active--;
      clearInterval(interval);
      intervals.delete(interval);
    });
  });
  const origin = await listen(server);
  const child = spawn(
    process.execPath,
    [
      join(process.cwd(), "src/cli.ts"),
      destination,
      ...Array.from({ length: 8 }, (_, index) => `${origin}/file-${index}.txt`),
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  try {
    await waitFor(() => active === 5);
    child.kill("SIGINT");
    await once(child, "exit");
    const bytesAtShutdown = bytes;
    assert.equal(active, 0);
    assert.equal(intervals.size, 0);
    assert.deepEqual(await readdir(destination), []);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(bytes, bytesAtShutdown);
    assert.deepEqual(await readdir(destination), []);
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
    }
    for (const interval of intervals) {
      clearInterval(interval);
    }
    await close(server);
  }
});
