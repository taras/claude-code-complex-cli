import { exit, main } from "effection";
import { downloadAll } from "./download-all.ts";

await main(function* (args) {
  let [destination, ...urls] = args;

  if (!destination || urls.length === 0) {
    yield* exit(1, "usage: download-all <destination> <url>...");
    return;
  }

  yield* downloadAll(urls, destination);
});
