import { createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { pathToFileURL } from "node:url";

import {
  ensure,
  main,
  until,
  useAbortSignal,
  type Operation,
} from "effection";
import { useTaskBuffer } from "@effectionx/task-buffer";

function outputName(url: string, index: number): string {
  const name = basename(new URL(url).pathname);
  return name || `download-${index + 1}`;
}

function* downloadOne(
  url: string,
  outputPath: string,
): Operation<void> {
  const partialPath = `${outputPath}.part`;
  let inFlight: Promise<unknown> | undefined;

  yield* ensure(function* () {
    if (inFlight) {
      try {
        yield* until(inFlight);
      } catch {
        // The original operation owns the error; cleanup only waits for it.
      }
    }
    yield* until(rm(partialPath, { force: true }));
  });

  const signal = yield* useAbortSignal();
  const request = fetch(url, { signal });
  inFlight = request;
  const response = yield* until(request);

  if (!response.ok) {
    if (response.body) {
      inFlight = response.body.cancel();
      yield* until(inFlight);
    }
    throw new Error(
      `Failed to download ${url}: ${response.status} ${response.statusText}`,
    );
  }
  if (!response.body) {
    throw new Error(`Failed to download ${url}: response has no body`);
  }

  const total = Number(response.headers.get("content-length")) || undefined;
  let downloaded = 0;
  const progress = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      downloaded += chunk.byteLength;
      const amount = total ? `${downloaded}/${total}` : String(downloaded);
      console.error(`[download] ${basename(outputPath)} ${amount} bytes`);
      callback(null, chunk);
    },
  });

  inFlight = pipeline(
    Readable.fromWeb(response.body as unknown as NodeReadableStream),
    progress,
    createWriteStream(partialPath),
    { signal },
  );
  yield* until(inFlight);
  inFlight = rename(partialPath, outputPath);
  yield* until(inFlight);
  console.error(`[done] ${basename(outputPath)}`);
}

/** Download every URL into destination, with at most five active downloads. */
export function* downloadAll(
  urls: Iterable<string>,
  destination: string,
): Operation<void> {
  const requests = Array.from(urls, (url, index) => ({
    url,
    name: outputName(url, index),
  }));
  const duplicate = requests.find(
    (request, index) =>
      requests.findIndex((candidate) => candidate.name === request.name) !==
      index,
  );
  if (duplicate) {
    throw new Error(`Duplicate output filename: ${duplicate.name}`);
  }

  let setup: Promise<unknown> | undefined;
  yield* ensure(function* () {
    if (setup) {
      try {
        yield* until(setup);
      } catch {
        // The main operation propagates setup errors.
      }
    }
  });
  setup = mkdir(destination, { recursive: true });
  yield* until(setup);

  const downloads = yield* useTaskBuffer(5);
  for (const request of requests) {
    yield* downloads.spawn(() =>
      downloadOne(request.url, join(destination, request.name)),
    );
  }
  yield* downloads;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main(function* () {
    const [destination, ...urls] = process.argv.slice(2);
    if (!destination || urls.length === 0) {
      throw new Error("Usage: download-all <destination> <url> [url ...]");
    }
    yield* downloadAll(urls, destination);
  });
}
