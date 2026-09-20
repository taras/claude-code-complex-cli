#!/usr/bin/env -S node --conditions=development

import { mkdir } from "node:fs/promises";
import { exit, main, until } from "effection";
import { downloadAll, type Progress } from "./download-all.ts";

await main(function* (args) {
  let [destination, ...urls] = args;

  if (!destination || urls.length === 0) {
    yield* exit(1, "usage: download-all <destination> <url>...");
  }

  yield* until(mkdir(destination, { recursive: true }));

  yield* downloadAll(urls, destination, { onProgress: report });

  process.stderr.write(`downloaded ${urls.length} file(s) to ${destination}\n`);
});

function report(progress: Progress): void {
  if (progress.type === "start") {
    process.stderr.write(`start    ${progress.url}\n`);
  }
  if (progress.type === "complete") {
    process.stderr.write(
      `complete ${progress.url} -> ${progress.path} (${progress.bytes} bytes)\n`,
    );
  }
}
