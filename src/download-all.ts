import { createWriteStream, mkdirSync, renameSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join, posix } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  all,
  ensure,
  type Operation,
  until,
  useAbortSignal,
} from "effection";

const MAX_CONCURRENT_DOWNLOADS = 5;

interface Download {
  index: number;
  target: string;
  url: string;
}

function fileName(url: string, index: number): string {
  const name = posix.basename(decodeURIComponent(new URL(url).pathname));
  return name || `download-${index + 1}`;
}

function* downloadOne(download: Download): Operation<void> {
  const partial = `${download.target}.${process.pid}.${download.index}.part`;
  let active: Promise<unknown> | undefined;
  let complete = false;

  // This is registered before useAbortSignal() so reverse-order scope cleanup
  // aborts the active I/O before we wait for it and remove the partial file.
  yield* ensure(function* () {
    if (active) {
      try {
        yield* until(active);
      } catch {
        // The original transfer error is propagated by the operation body.
      }
    }

    if (!complete) {
      yield* until(rm(partial, { force: true }));
    }
  });

  const signal = yield* useAbortSignal();
  const fetchPromise = fetch(download.url, { signal });
  active = fetchPromise;
  const response = yield* until(fetchPromise);

  if (!response.ok) {
    if (response.body) {
      const cancelPromise = response.body.cancel();
      active = cancelPromise;
      yield* until(cancelPromise);
    }
    throw new Error(
      `failed to download ${download.url}: ${response.status} ${response.statusText}`,
    );
  }

  if (!response.body) {
    throw new Error(`failed to download ${download.url}: response has no body`);
  }

  const readable = Readable.fromWeb(
    response.body as import("node:stream/web").ReadableStream<Uint8Array>,
  );
  const pipelinePromise = pipeline(readable, createWriteStream(partial), {
    signal,
  });
  active = pipelinePromise;
  yield* until(pipelinePromise);

  renameSync(partial, download.target);
  complete = true;
}

/** Download every URL into destination with at most five active transfers. */
export function* downloadAll(
  urls: readonly string[],
  destination: string,
): Operation<void> {
  const downloads = urls.map((url, index) => ({
    index,
    target: join(destination, fileName(url, index)),
    url,
  }));

  const targets = new Set(downloads.map(({ target }) => target));
  if (targets.size !== downloads.length) {
    throw new Error("download URLs must have unique destination file names");
  }

  mkdirSync(destination, { recursive: true });

  let next = 0;
  let completed = 0;
  const workerCount = Math.min(MAX_CONCURRENT_DOWNLOADS, downloads.length);
  const workers = Array.from({ length: workerCount }, function* () {
    while (next < downloads.length) {
      const download = downloads[next++];
      yield* downloadOne(download);
      completed++;
      console.log(
        `Downloaded ${posix.basename(new URL(download.url).pathname) || download.target} (${completed}/${downloads.length})`,
      );
    }
  });

  yield* all(workers);
}
