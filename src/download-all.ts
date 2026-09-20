import { each, ensure, stream, until, useAbortSignal } from "effection";
import type { Operation } from "effection";
import { useTaskBuffer } from "@effectionx/task-buffer";
import { open, rm } from "node:fs/promises";
import { basename, join } from "node:path";

const MAX_CONCURRENT_DOWNLOADS = 5;

export type Progress =
  | { type: "start"; url: string; path: string }
  | { type: "done"; url: string; path: string; bytes: number; completed: number; total: number };

export function report(progress: Progress): void {
  if (progress.type === "start") {
    console.log(`↓ ${progress.url}`);
  } else {
    console.log(
      `✓ [${progress.completed}/${progress.total}] ${progress.url} (${progress.bytes} bytes)`,
    );
  }
}

export function* downloadAll(
  urls: string[],
  destination: string,
  onProgress: (progress: Progress) => void = report,
): Operation<void> {
  const buffer = yield* useTaskBuffer(MAX_CONCURRENT_DOWNLOADS);

  let completed = 0;

  for (const url of urls) {
    yield* buffer.spawn(function* () {
      const path = join(destination, fileNameFor(url));

      onProgress({ type: "start", url, path });

      const bytes = yield* download(url, path);

      completed++;
      onProgress({ type: "done", url, path, bytes, completed, total: urls.length });
    });
  }

  yield* buffer;
}

function* download(url: string, path: string): Operation<number> {
  const signal = yield* useAbortSignal();
  const response = yield* until(fetch(url, { signal }));

  if (!response.ok) {
    throw new Error(`GET ${url} failed: ${response.status} ${response.statusText}`);
  }

  let complete = false;

  // Registered before the handle is opened so that it tears down after the
  // handle is closed: scope destructors run in reverse order of registration.
  yield* ensure(function* () {
    if (!complete) {
      yield* until(rm(path, { force: true }));
    }
  });

  const handle = yield* until(open(path, "w"));

  // close() waits for writes abandoned by a halt, so no write outlives shutdown.
  yield* ensure(function* () {
    yield* until(handle.close());
  });

  let bytes = 0;

  if (response.body) {
    for (const chunk of yield* each(stream(response.body))) {
      yield* until(handle.write(chunk));
      bytes += chunk.byteLength;
      yield* each.next();
    }
  }

  complete = true;

  return bytes;
}

function fileNameFor(url: string): string {
  const name = basename(new URL(url).pathname);

  if (name === "") {
    throw new Error(`cannot derive a file name from ${url}`);
  }

  return name;
}
