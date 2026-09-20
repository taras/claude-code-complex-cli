import { type Operation, ensure, scoped, until, useAbortSignal } from "effection";
import { useTaskBuffer } from "@effectionx/task-buffer";
import { mkdir, open, rm } from "node:fs/promises";
import { basename, join } from "node:path";

export const MAX_CONCURRENT_DOWNLOADS = 5;

export type DownloadEvent =
  | { type: "start"; url: string; path: string; bytes: number }
  | { type: "progress"; url: string; path: string; bytes: number }
  | { type: "complete"; url: string; path: string; bytes: number };

export interface DownloadAllOptions {
  onProgress?: (event: DownloadEvent) => void;
}

export function downloadAll(
  urls: string[],
  destination: string,
  options: DownloadAllOptions = {},
): Operation<void> {
  let report = options.onProgress ?? createStderrReporter();
  let paths = resolveDestinations(urls, destination);

  // `scoped()` is the error boundary: a download that fails inside the buffer
  // fails this scope rather than the caller's, and every remaining task is torn
  // down before `downloadAll` returns or throws.
  return scoped(function* () {
    yield* until(mkdir(destination, { recursive: true }));

    let buffer = yield* useTaskBuffer(MAX_CONCURRENT_DOWNLOADS);

    for (let [index, url] of urls.entries()) {
      yield* buffer.spawn(() => download(url, paths[index], report));
    }

    yield* buffer;
  });
}

function* download(
  url: string,
  path: string,
  report: (event: DownloadEvent) => void,
): Operation<void> {
  let complete = false;

  // Teardown runs in reverse registration order, so this removal happens after
  // the scope's abort signal has torn down the request and the file handle has
  // been closed.
  yield* ensure(function* () {
    if (!complete) {
      yield* until(rm(path, { force: true }));
    }
  });

  let signal = yield* useAbortSignal();
  let response = yield* until(fetch(url, { signal }));

  if (!response.ok) {
    throw new Error(`${url} failed: ${response.status} ${response.statusText}`);
  }

  if (!response.body) {
    throw new Error(`${url} failed: response has no body`);
  }

  let handle = yield* until(open(path, "w"));
  yield* ensure(function* () {
    yield* until(handle.close());
  });

  let reader = response.body.getReader();

  let bytes = 0;
  report({ type: "start", url, path, bytes });

  while (true) {
    let chunk = yield* until(reader.read());
    if (chunk.done) {
      break;
    }
    yield* until(handle.write(chunk.value));
    bytes += chunk.value.byteLength;
    report({ type: "progress", url, path, bytes });
  }

  complete = true;
  report({ type: "complete", url, path, bytes });
}

function resolveDestinations(urls: string[], destination: string): string[] {
  let taken = new Set<string>();

  return urls.map((url, index) => {
    let candidate = basename(new URL(url).pathname);
    let name = candidate && candidate !== "." && candidate !== ".."
      ? candidate
      : `download-${index}`;

    if (taken.has(name)) {
      name = `${index}-${name}`;
    }
    taken.add(name);

    return join(destination, name);
  });
}

const PROGRESS_REPORT_INTERVAL = 1024 * 1024;

export function createStderrReporter(): (event: DownloadEvent) => void {
  let reported = new Map<string, number>();

  return (event) => {
    if (event.type === "start") {
      reported.set(event.url, 0);
      process.stderr.write(`start     ${event.url}\n`);
      return;
    }

    if (event.type === "complete") {
      reported.delete(event.url);
      process.stderr.write(`complete  ${event.url} (${event.bytes} bytes)\n`);
      return;
    }

    let last = reported.get(event.url) ?? 0;
    if (event.bytes - last >= PROGRESS_REPORT_INTERVAL) {
      reported.set(event.url, event.bytes);
      process.stderr.write(`progress  ${event.url} (${event.bytes} bytes)\n`);
    }
  };
}
