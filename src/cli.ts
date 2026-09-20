#!/usr/bin/env -S node --conditions=development
import { exit, main } from "effection";
import { mkdir } from "node:fs/promises";
import { until } from "effection";
import { downloadAll } from "./download-all.ts";

await main(function* (args) {
  const [destination, ...urls] = args;

  if (!destination || urls.length === 0) {
    yield* exit(1, "usage: download-all <destination> <url>...");
  }

  yield* until(mkdir(destination, { recursive: true }));
  yield* downloadAll(urls, destination);
});
