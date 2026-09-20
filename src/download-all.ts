import { each, ensure, type Operation, scoped, stream, until, useAbortSignal } from "effection";
import { useTaskBuffer } from "@effectionx/task-buffer";
import { mkdir, open, rm } from "node:fs/promises";
import { basename, join } from "node:path";

/** The most downloads that may be in flight at the same time. */
export const MAX_CONCURRENT_DOWNLOADS = 5;

export type Progress =
  | { type: "start"; url: string; path: string; total?: number }
  | { type: "data"; url: string; path: string; received: number; total?: number }
  | { type: "done"; url: string; path: string; received: number };

export interface DownloadAllOptions {
  /** Called synchronously as downloads make progress. Defaults to writing to stderr. */
  onProgress?: (progress: Progress) => void;
}

/**
 * Download every `url` into `destination`, at most
 * `MAX_CONCURRENT_DOWNLOADS` at a time.
 *
 * The first failure halts everything still running or queued and propagates
 * out of this operation. Any file that did not finish downloading — because of
 * a failure, or because the enclosing scope was halted (CTRL-C) — is removed
 * before this operation completes.
 */
export function downloadAll(
  urls: string[],
  destination: string,
  options: DownloadAllOptions = {},
): Operation<void> {
  let onProgress = options.onProgress ?? reportToStderr;

  // `scoped()` is the boundary: the buffer, its tasks, their abort signals and
  // their file handles are all torn down before `downloadAll` returns, and a
  // failure in a background task is raised here rather than escaping upward
  // untethered.
  return scoped(function* () {
    yield* until(mkdir(destination, { recursive: true }));

    let buffer = yield* useTaskBuffer(MAX_CONCURRENT_DOWNLOADS);

    // Whichever way this scope comes apart, halting the active downloads frees
    // capacity in the buffer, and the buffer answers that by admitting requests
    // that are still queued. Without this guard, shutting down starts fresh
    // HTTP requests on the way out. `stopped` is set from both directions:
    //
    //  - by `ensure`, for a halt that arrives from outside (CTRL-C). Destructors
    //    run in reverse order of registration, so this one runs before the
    //    buffer is torn down.
    //  - by the catch below, for a failure that starts inside the buffer, whose
    //    own scope unwinds before this one's destructors get to run.
    //
    // Either way, a late admission returns without touching the network or the
    // disk.
    let stopped = false;
    yield* ensure(() => {
      stopped = true;
    });

    for (let [index, url] of urls.entries()) {
      let path = join(destination, fileNameFor(url, index));
      yield* buffer.spawn(function* () {
        if (stopped) {
          return;
        }
        try {
          yield* download(url, path, onProgress);
        } catch (error) {
          stopped = true;
          throw error;
        }
      });
    }

    yield* buffer;
  });
}

function* download(
  url: string,
  path: string,
  onProgress: (progress: Progress) => void,
): Operation<void> {
  let signal = yield* useAbortSignal();

  let response = yield* until(fetch(url, { signal }));

  if (!response.ok) {
    throw new Error(`GET ${url} failed: ${response.status} ${response.statusText}`);
  }
  if (!response.body) {
    throw new Error(`GET ${url} succeeded, but the response had no body`);
  }

  let total = contentLengthOf(response);
  let complete = false;

  // `open()` is a promise, so it is already running: halting this task will not
  // un-create the file or un-allocate the descriptor. Cleanup is therefore
  // registered against the pending promise rather than against a handle we do
  // not have yet, so that a halt arriving mid-open still closes the descriptor
  // and removes the file. `close()` waits for any pending write, and `rm()`
  // runs after it, so nothing touches the filesystem once teardown is done.
  let opening = open(path, "w");

  yield* ensure(function* () {
    yield* until(opening.then((handle) => handle.close(), () => {}));
    if (!complete) {
      yield* until(rm(path, { force: true }));
    }
  });

  let handle = yield* until(opening);

  onProgress({ type: "start", url, path, total });

  let received = 0;
  for (let chunk of yield* each(stream(response.body))) {
    yield* until(handle.write(chunk));
    received += chunk.byteLength;
    onProgress({ type: "data", url, path, received, total });
    yield* each.next();
  }

  complete = true;
  onProgress({ type: "done", url, path, received });
}

function contentLengthOf(response: Response): number | undefined {
  let header = response.headers.get("content-length");
  if (!header) {
    return undefined;
  }
  let total = Number(header);
  return Number.isFinite(total) ? total : undefined;
}

function fileNameFor(url: string, index: number): string {
  let name = basename(new URL(url).pathname);
  return name === "" || name === "/" ? `download-${index}` : name;
}

let lastReported = new Map<string, number>();

function reportToStderr(progress: Progress): void {
  if (progress.type === "start") {
    process.stderr.write(`\u2193 ${progress.url}\n`);
  } else if (progress.type === "done") {
    lastReported.delete(progress.url);
    process.stderr.write(`\u2713 ${progress.path} (${progress.received} bytes)\n`);
  } else {
    // One line per whole percent, or per 64KiB when the size is unknown, so
    // that a large download is visibly progressing without flooding the log.
    let step = progress.total
      ? Math.floor((progress.received / progress.total) * 100)
      : Math.floor(progress.received / 65536);
    if (lastReported.get(progress.url) !== step) {
      lastReported.set(progress.url, step);
      let amount = progress.total
        ? `${step}%`
        : `${progress.received} bytes`;
      process.stderr.write(`  ${progress.url} ${amount}\n`);
    }
  }
}
