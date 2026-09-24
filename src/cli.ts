#!/usr/bin/env node
import { exit, main } from "effection";
import { downloadAll } from "./download-all.ts";

await main(function* (args) {
  let [destination, ...urls] = args;

  if (!destination || urls.length === 0) {
    console.error("usage: download-all <destination> <url...>");
    yield* exit(1);
  }

  let paths = yield* downloadAll(urls, destination);

  console.log(`downloaded ${paths.length} files to ${destination}`);
});
