import { all, call, ensure, scoped, until, useAbortSignal } from 'effection';
import { createWriteStream } from 'node:fs';
import { mkdir, rm, rename } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { basename, join } from 'node:path';

const CONCURRENCY = 5;

function targetName(url, index) {
  let name = '';
  try { name = basename(new URL(url).pathname); } catch { /* not a parseable URL */ }
  return name && name !== '/' && name !== '.' ? name : `file-${index}`;
}

function* downloadOne(url, dir, index) {
  const finalPath = join(dir, targetName(url, index));
  const partPath = `${finalPath}.part`;
  let committed = false;

  // `ensure` registers scope-level cleanup that runs on completion, error or
  // halt. Async cleanup returns an Operation (per the `ensure` docs); we never
  // yield inside a `finally`, which AGENTS.md lists as an anti-pattern.
  yield* ensure(function* () {
    if (!committed) {
      yield* call(() => rm(partPath, { force: true }));
    }
  });

  // `scoped` encapsulates the transfer so none of its effects outlive it. Its
  // documented behaviour is that everything inside is shut down at scope exit
  // -- including the AbortSignal, whose docs state it triggers when its scope
  // is "completed, errored, or halted". So the socket and the file stream are
  // aborted when this block exits, BEFORE the `ensure` above deletes the
  // partial file. Without `scoped` the signal is bound to `downloadOne` and
  // aborts after that cleanup instead of before it.
  yield* scoped(function* () {
    const signal = yield* useAbortSignal();

    const response = yield* until(fetch(url, { signal }));
    if (!response.ok) {
      throw new Error(`${url} -> HTTP ${response.status} ${response.statusText}`);
    }
    if (!response.body) {
      throw new Error(`${url} -> response had no body`);
    }

    yield* until(pipeline(
      Readable.fromWeb(response.body),
      createWriteStream(partPath),
      { signal },
    ));
  });

  // Rename is atomic, so the final path never exposes a partial file.
  yield* call(() => rename(partPath, finalPath));
  committed = true;
  return finalPath;
}

export function* downloadAll(urls, destination) {
  yield* call(() => mkdir(destination, { recursive: true }));

  let cursor = 0;
  let completed = 0;

  function* worker() {
    // Plain JavaScript run-to-completion: there is no yield point between
    // the bounds check and `cursor++`, so no two workers claim the same
    // index. This is a property of the language, not of Effection.
    while (cursor < urls.length) {
      const index = cursor++;
      const url = urls[index];
      yield* downloadOne(url, destination, index);
      completed++;
      console.log(`[${completed}/${urls.length}] ${url}`);
    }
  }

  // Operations are dormant until interpreted, so building the array does not
  // start anything. `all` errors if any member errors, halting the rest.
  yield* all(Array.from({ length: Math.min(CONCURRENCY, urls.length) }, () => worker()));
  return completed;
}
