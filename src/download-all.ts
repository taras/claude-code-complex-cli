import { open, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  each,
  ensure,
  type Operation,
  scoped,
  stream,
  until,
  useAbortSignal,
} from "effection";
import { useTaskBuffer } from "@effectionx/task-buffer";

export const MAX_CONCURRENT_DOWNLOADS = 5;

export type Progress =
  | { type: "start"; url: string; path: string }
  | { type: "data"; url: string; path: string; bytes: number }
  | { type: "complete"; url: string; path: string; bytes: number };

export interface DownloadAllOptions {
  onProgress?(progress: Progress): void;
}

/**
 * Download every url into destination, running at most
 * MAX_CONCURRENT_DOWNLOADS at a time.
 */
export function downloadAll(
  urls: Iterable<string>,
  destination: string,
  options: DownloadAllOptions = {},
): Operation<void> {
  return scoped(function* () {
    let buffer = yield* useTaskBuffer(MAX_CONCURRENT_DOWNLOADS);

    for (let url of urls) {
      yield* buffer.spawn(() => download(url, destination, options));
    }

    yield* buffer;
  });
}

function* download(
  url: string,
  destination: string,
  options: DownloadAllOptions,
): Operation<void> {
  let path = join(destination, fileNameFor(url));
  let signal = yield* useAbortSignal();

  let response = yield* until(fetch(url, { signal }));

  if (!response.ok) {
    throw new Error(
      `failed to download ${url}: ${response.status} ${response.statusText}`,
    );
  }
  if (!response.body) {
    throw new Error(`failed to download ${url}: response has no body`);
  }

  let file = yield* until(open(path, "w"));
  let complete = false;

  yield* ensure(function* () {
    yield* until(file.close());
    if (!complete) {
      yield* until(rm(path, { force: true }));
    }
  });

  let bytes = 0;

  options.onProgress?.({ type: "start", url, path });

  for (let chunk of yield* each(stream(response.body))) {
    yield* until(file.write(chunk));
    bytes += chunk.byteLength;
    options.onProgress?.({ type: "data", url, path, bytes });
    yield* each.next();
  }

  complete = true;
  options.onProgress?.({ type: "complete", url, path, bytes });
}

function fileNameFor(url: string): string {
  let name = basename(new URL(url).pathname);
  if (!name) {
    return "index";
  }
  return name;
}
