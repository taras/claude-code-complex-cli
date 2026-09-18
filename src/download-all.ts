import { createWriteStream, mkdirSync, renameSync } from "node:fs";
import { rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

import {
  all,
  ensure,
  spawn,
  until,
  useAbortSignal,
  type Operation,
} from "effection";

const MAX_CONCURRENT_DOWNLOADS = 5;

interface Download {
  index: number;
  url: string;
  name: string;
  destinationPath: string;
  partialPath: string;
}

/**
 * Download every URL into `destination`, with at most five active downloads.
 *
 * This is an Effection operation. Run it with `yield* downloadAll(...)` from
 * another operation or pass it to `main()`/`run()`.
 */
export function* downloadAll(
  urls: Iterable<string | URL>,
  destination: string,
): Operation<void> {
  const destinationDirectory = resolve(destination);
  const downloads = planDownloads(urls, destinationDirectory);

  mkdirSync(destinationDirectory, { recursive: true });

  let nextIndex = 0;
  let completed = 0;

  function* worker(): Operation<void> {
    while (true) {
      const download = downloads[nextIndex++];

      if (!download) {
        return;
      }

      // A child task gives this file its own cleanup scope. Awaiting it keeps
      // each worker sequential while the five workers themselves run in
      // parallel under all().
      const task = yield* spawn(() => downloadOne(download));
      yield* task;

      completed += 1;
      console.log(`[${completed}/${downloads.length}] ${download.name}`);
    }
  }

  const workerCount = Math.min(MAX_CONCURRENT_DOWNLOADS, downloads.length);
  yield* all(Array.from({ length: workerCount }, () => worker()));
}

function* downloadOne(download: Download): Operation<void> {
  let fetchPromise: Promise<Response> | undefined;
  let pipelinePromise: Promise<void> | undefined;
  let bodyCancelPromise: Promise<void> | undefined;
  let complete = false;

  // Register this before useAbortSignal(). Destructors run in reverse order,
  // so the bound signal aborts fetch/pipeline before this waits for settlement
  // and removes the partial file.
  yield* ensure(function* cleanupPartialDownload() {
    if (complete) {
      return;
    }

    yield* settle(fetchPromise);
    yield* settle(pipelinePromise);
    yield* settle(bodyCancelPromise);

    try {
      yield* until(rm(download.partialPath, { force: true }));
    } catch (error) {
      throw new Error(`Could not remove partial file ${download.partialPath}`, {
        cause: error,
      });
    }
  });

  const signal = yield* useAbortSignal();

  fetchPromise = fetch(download.url, { signal });
  const response = yield* until(fetchPromise);

  if (!response.ok) {
    bodyCancelPromise = response.body?.cancel() ?? Promise.resolve();
    yield* until(bodyCancelPromise);
    throw new Error(
      `Download failed for ${download.url}: HTTP ${response.status} ${response.statusText}`,
    );
  }

  if (!response.body) {
    throw new Error(`Download failed for ${download.url}: response has no body`);
  }

  const source = Readable.fromWeb(
    response.body as unknown as NodeReadableStream<Uint8Array>,
  );
  const target = createWriteStream(download.partialPath, { flags: "wx" });
  pipelinePromise = pipeline(source, target, { signal });
  yield* until(pipelinePromise);

  renameSync(download.partialPath, download.destinationPath);
  complete = true;
}

function* settle(promise: Promise<unknown> | undefined): Operation<void> {
  if (!promise) {
    return;
  }

  try {
    yield* until(promise);
  } catch {
    // Cleanup only needs the eager Promise to settle. The original operation
    // propagates its own failure.
  }
}

function planDownloads(
  urls: Iterable<string | URL>,
  destination: string,
): Download[] {
  const names = new Set<string>();

  return Array.from(urls, (input, index) => {
    const url = new URL(input);
    const encodedName = basename(url.pathname);
    const name = encodedName
      ? basename(decodeURIComponent(encodedName))
      : `download-${index + 1}`;

    if (!name || name === "." || name === "..") {
      throw new Error(`Cannot derive a file name from ${url.href}`);
    }

    if (names.has(name)) {
      throw new Error(`Multiple URLs resolve to the same file name: ${name}`);
    }
    names.add(name);

    return {
      index,
      url: url.href,
      name,
      destinationPath: join(destination, name),
      partialPath: join(
        destination,
        `.${name}.${process.pid}.${index}.part`,
      ),
    };
  });
}
