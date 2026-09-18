import {
  each,
  ensure,
  type Operation,
  stream,
  until,
  useAbortSignal,
} from "effection";
import { useTaskBuffer } from "@effectionx/task-buffer";
import { mkdir, open, rm } from "node:fs/promises";
import { join } from "node:path";

/** How many downloads are allowed to be in flight at the same time. */
export const MAX_CONCURRENT_DOWNLOADS = 5;

export interface Progress {
  /** the url that just finished downloading */
  url: string;
  /** where its contents were written */
  path: string;
  /** how many downloads have finished so far */
  completed: number;
  /** how many downloads were requested in total */
  total: number;
}

export interface DownloadAllOptions {
  /** maximum number of downloads in flight, defaults to {@link MAX_CONCURRENT_DOWNLOADS} */
  concurrency?: number;
  /** called every time a download completes, defaults to printing to stdout */
  onProgress?: (progress: Progress) => void;
}

/**
 * Download every url into `destination`, at most `concurrency` at a time.
 *
 * If any download fails, the failure halts every other download and is
 * raised from this operation. Partially written files never survive: a
 * download that fails, or that is interrupted because the enclosing scope
 * went away, removes the file it was writing.
 */
export function* downloadAll(
  urls: readonly string[],
  destination: string,
  options: DownloadAllOptions = {},
): Operation<void> {
  const {
    concurrency = MAX_CONCURRENT_DOWNLOADS,
    onProgress = printProgress,
  } = options;

  yield* until(mkdir(destination, { recursive: true }));

  const paths = destinationPaths(urls, destination);
  const buffer = yield* useTaskBuffer(concurrency);

  let completed = 0;

  for (const [index, url] of urls.entries()) {
    const path = paths[index]!;
    yield* buffer.spawn(function* () {
      yield* download(url, path);
      completed++;
      onProgress({ url, path, completed, total: urls.length });
    });
  }

  yield* buffer;
}

/**
 * Fetch `url` and write the response body to `path`.
 *
 * The request is bound to this operation's scope, so it is aborted the
 * moment the operation goes away, and the file is deleted unless the
 * body was written in full.
 */
export function* download(url: string, path: string): Operation<void> {
  let complete = false;

  // Destructors run in reverse order of registration, so registering this
  // first means the partial file is removed last: after the descriptor has
  // been closed and after the request has been aborted.
  yield* ensure(function* () {
    if (!complete) {
      yield* until(rm(path, { force: true }));
    }
  });

  const signal = yield* useAbortSignal();
  const response = yield* until(fetch(url, { signal }));

  if (!response.ok) {
    throw new Error(`GET ${url}: ${response.status} ${response.statusText}`);
  }
  if (!response.body) {
    throw new Error(`GET ${url}: response has no body`);
  }

  const file = yield* until(open(path, "w"));

  // Registered last, so it runs first: pending writes are flushed and the
  // descriptor is closed before the request is aborted or the file removed.
  yield* ensure(function* () {
    yield* until(file.close());
  });

  for (const chunk of yield* each(stream(response.body))) {
    yield* until(file.write(chunk));
    yield* each.next();
  }

  complete = true;
}

function printProgress({ url, completed, total }: Progress): void {
  console.log(`[${completed}/${total}] ${url}`);
}

/** Give each url its own file name within `destination`. */
function destinationPaths(
  urls: readonly string[],
  destination: string,
): string[] {
  const taken = new Set<string>();

  return urls.map((url, index) => {
    const name = fileNameFor(url, index);
    let candidate = name;

    for (let suffix = 1; taken.has(candidate); suffix++) {
      const dot = name.lastIndexOf(".");
      const stem = dot > 0 ? name.slice(0, dot) : name;
      const extension = dot > 0 ? name.slice(dot) : "";
      candidate = `${stem}-${suffix}${extension}`;
    }

    taken.add(candidate);
    return join(destination, candidate);
  });
}

function fileNameFor(url: string, index: number): string {
  let last = "";

  try {
    const { pathname } = new URL(url);
    last = decodeURIComponent(pathname.split("/").filter(Boolean).pop() ?? "");
  } catch {
    last = "";
  }

  const name = last.replace(/[^\w.\-]+/g, "_");

  if (name === "" || name === "." || name === "..") {
    return `download-${index + 1}`;
  }
  return name;
}
