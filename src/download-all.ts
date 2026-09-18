import { each, ensure, type Operation, scoped, stream, until, useAbortSignal } from "effection";
import { useTaskBuffer } from "@effectionx/task-buffer";
import { mkdir, open, rm } from "node:fs/promises";
import { basename, join } from "node:path";

export const MAX_CONCURRENT_DOWNLOADS = 5;

export interface DownloadAllOptions {
  concurrency?: number;
  onProgress?(progress: { url: string; path: string; completed: number; total: number }): void;
}

/**
 * Download every url into `destination`, at most `concurrency` at a time.
 *
 * Fails fast: the first download to fail halts the others. Partially written
 * files are removed. Everything is bound to the calling scope, so halting the
 * caller (e.g. SIGINT under `main()`) tears all of it down before returning.
 */
export function downloadAll(
  urls: string[],
  destination: string,
  options: DownloadAllOptions = {},
): Operation<string[]> {
  let { concurrency = MAX_CONCURRENT_DOWNLOADS, onProgress = report } = options;

  return scoped(function* () {
    yield* until(mkdir(destination, { recursive: true }));

    let buffer = yield* useTaskBuffer(concurrency);
    let paths = urls.map((url, index) => join(destination, filenameFor(url, index)));
    let completed = 0;

    for (let [index, url] of urls.entries()) {
      let path = paths[index];
      yield* buffer.spawn(function* () {
        yield* download(url, path);
        completed++;
        onProgress({ url, path, completed, total: urls.length });
      });
    }

    yield* buffer;

    return paths;
  });
}

function* download(url: string, path: string): Operation<void> {
  let complete = false;

  // Registered before the file exists and before the handle, so that it runs
  // last: the handle is always closed before we try to unlink the partial file.
  yield* ensure(function* () {
    if (!complete) {
      yield* until(rm(path, { force: true }));
    }
  });

  let signal = yield* useAbortSignal();
  let response = yield* until(fetch(url, { signal }));

  if (!response.ok) {
    throw new Error(`GET ${url} failed: ${response.status} ${response.statusText}`);
  }

  // `until()` abandons a pending promise when the scope is halted, so cleanup is
  // registered against the open() promise rather than the handle: otherwise a halt
  // landing while open() is in flight leaks a file descriptor that nothing closes.
  let opening = open(path, "w");
  opening.catch(() => {});
  yield* ensure(function* () {
    yield* until(opening.then((handle) => handle.close(), () => {}));
  });

  let handle = yield* until(opening);

  if (response.body) {
    for (let chunk of yield* each(stream(response.body))) {
      yield* until(handle.write(chunk));
      yield* each.next();
    }
  }

  complete = true;
}

function filenameFor(url: string, index: number): string {
  let name = "";
  try {
    name = basename(new URL(url).pathname);
  } catch {
    name = "";
  }
  if (!name || name === "/" || name === "." || name === "..") {
    return `file-${index}`;
  }
  return `${index}-${name}`;
}

function report({ path, completed, total }: { path: string; completed: number; total: number }): void {
  console.log(`[${completed}/${total}] ${path}`);
}
