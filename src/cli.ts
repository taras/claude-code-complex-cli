#!/usr/bin/env node

import { main } from "effection";

import { downloadAll } from "./download-all.ts";

await main(function* (args) {
  const [destination, ...urls] = args;

  if (!destination || urls.length === 0) {
    throw new Error("Usage: download-all <destination> <url> [url ...]");
  }

  yield* downloadAll(urls, destination);
});
