import { main } from "effection";
import { downloadAll } from "./download-all.ts";

await main(function* (args) {
  let [destination, ...urls] = args;

  if (!destination || urls.length === 0) {
    throw new Error("usage: download-all <destination> <url>...");
  }

  yield* downloadAll(urls, destination);
});
