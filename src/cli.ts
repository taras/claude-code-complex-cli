#!/usr/bin/env node

import { main } from "effection";

import { downloadAll } from "./download-all.ts";

await main(function* () {
  const [destination, ...urls] = process.argv.slice(2);

  if (!destination || urls.length === 0) {
    throw new Error("usage: download-all <destination> <url> [url ...]");
  }

  yield* downloadAll(urls, destination);
});
