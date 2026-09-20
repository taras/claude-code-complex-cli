import { type Operation, ensure, main, until, useAbortSignal } from "effection";
import { useTaskBuffer } from "@effectionx/task-buffer";
import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const MAX_CONCURRENT_DOWNLOADS = 5;

function destinationPathFor(url: string, destination: string, index: number): string {
  const name = basename(new URL(url).pathname) || "download";
  return join(destination, `${index}-${name}`);
}

function* downloadOne(url: string, path: string): Operation<void> {
  let completed = false;

  yield* ensure(function* () {
    if (!completed) {
      yield* until(rm(path, { force: true }));
    }
  });

  const signal = yield* useAbortSignal();

  console.log(`start:    ${url}`);

  const response = yield* until(fetch(url, { signal }));

  if (!response.ok || !response.body) {
    throw new Error(`download failed for ${url}: ${response.status} ${response.statusText}`);
  }

  const total = Number(response.headers.get("content-length")) || undefined;
  let received = 0;

  const source = Readable.fromWeb(response.body as never);
  source.on("data", (chunk: Buffer) => {
    received += chunk.length;
    const progress = total ? `${Math.floor((received / total) * 100)}%` : `${received} bytes`;
    console.log(`progress: ${url} - ${progress}`);
  });

  yield* until(pipeline(source, createWriteStream(path), { signal }));

  completed = true;
  console.log(`done:     ${url}`);
}

export function* downloadAllOperation(urls: string[], destination: string): Operation<void> {
  yield* until(mkdir(destination, { recursive: true }));

  const buffer = yield* useTaskBuffer(MAX_CONCURRENT_DOWNLOADS);

  for (const [index, url] of urls.entries()) {
    const path = destinationPathFor(url, destination, index);
    yield* buffer.spawn(() => downloadOne(url, path));
  }

  yield* buffer;
}

export async function downloadAll(urls: string[], destination: string): Promise<void> {
  await main(function* () {
    yield* downloadAllOperation(urls, destination);
  });
}
