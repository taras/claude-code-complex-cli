import { open, mkdir, rename, rm, type FileHandle } from "node:fs/promises";
import { basename, join } from "node:path";

import {
  each,
  ensure,
  stream,
  until,
  useAbortSignal,
  type Operation,
} from "effection";
import { useTaskBuffer } from "@effectionx/task-buffer";

function outputName(url: string, index: number): string {
  const name = basename(decodeURIComponent(new URL(url).pathname));
  return name || `download-${index + 1}`;
}

function* writeChunk(file: FileHandle, chunk: Uint8Array): Operation<void> {
  let offset = 0;

  while (offset < chunk.byteLength) {
    const { bytesWritten } = yield* until(
      file.write(chunk, offset, chunk.byteLength - offset, null),
    );

    if (bytesWritten === 0) {
      throw new Error("file write made no progress");
    }

    offset += bytesWritten;
  }
}

function* downloadOne(
  url: string,
  destination: string,
  index: number,
  total: number,
  onComplete: (fileName: string) => void,
): Operation<void> {
  const fileName = outputName(url, index);
  const finalPath = join(destination, fileName);
  const partialPath = join(destination, `.${fileName}.${index}.part`);
  let opening: Promise<FileHandle> | undefined;
  let file: FileHandle | undefined;
  let committing: Promise<void> | undefined;
  let closed = false;
  let committed = false;

  yield* ensure(function* cleanup() {
    let cleanupError: unknown;

    if (committing && !committed) {
      try {
        yield* until(committing);
        committed = true;
      } catch (error) {
        cleanupError = error;
      }
    }

    if (opening && !file) {
      try {
        file = yield* until(opening);
      } catch {
        // The open failure is already propagated by the download operation.
      }
    }

    if (file && !closed) {
      try {
        yield* until(file.close());
      } catch (error) {
        cleanupError ??= error;
      }
      closed = true;
    }

    if (!committed) {
      try {
        yield* until(rm(partialPath, { force: true }));
      } catch (error) {
        cleanupError ??= error;
      }
    }

    if (cleanupError) {
      throw cleanupError;
    }
  });

  opening = open(partialPath, "w");
  const openedFile = yield* until(opening);
  file = openedFile;

  console.error(`Downloading ${index + 1}/${total}: ${fileName}`);

  let request: Promise<Response> | undefined;
  yield* ensure(function* settleRequest() {
    if (request) {
      try {
        yield* until(request);
      } catch {
        // The request failure is already propagated by the download operation.
      }
    }
  });
  const signal = yield* useAbortSignal();
  request = fetch(url, { signal });
  const response = yield* until(request);

  if (!response.ok) {
    throw new Error(`GET ${url} failed: ${response.status} ${response.statusText}`);
  }

  if (!response.body) {
    throw new Error(`GET ${url} returned no response body`);
  }

  const body = response.body as unknown as AsyncIterable<Uint8Array>;
  for (const chunk of yield* each(stream(body))) {
    yield* writeChunk(openedFile, chunk);
    yield* each.next();
  }

  yield* until(openedFile.close());
  closed = true;
  committing = rename(partialPath, finalPath);
  yield* until(committing);
  committed = true;
  onComplete(fileName);
}

/** Download every URL with a maximum of five active downloads. */
export function* downloadAll(
  urls: readonly string[],
  destination: string,
): Operation<void> {
  const creatingDestination = mkdir(destination, { recursive: true });
  yield* ensure(function* settleDestinationCreation() {
    try {
      yield* until(creatingDestination);
    } catch {
      // The mkdir failure is already propagated by the download operation.
    }
  });
  yield* until(creatingDestination);

  let completed = 0;
  let stopped = false;
  const buffer = yield* useTaskBuffer(5);
  yield* ensure(() => {
    stopped = true;
  });

  for (const [index, url] of urls.entries()) {
    yield* buffer.spawn(function* () {
      if (stopped) {
        return;
      }

      try {
        yield* downloadOne(url, destination, index, urls.length, (fileName) => {
          completed += 1;
          console.error(`Downloaded ${completed}/${urls.length}: ${fileName}`);
        });
      } catch (error) {
        stopped = true;
        throw error;
      }
    });
  }

  yield* buffer;
}
