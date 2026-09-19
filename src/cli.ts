import { exit, main } from "effection";
import { downloadAll } from "./download-all.ts";

await main(function* () {
  const [destination, ...urls] = process.argv.slice(2);

  if (!destination || urls.length === 0) {
    yield* exit(2, "usage: download-all <destination> <url>...");
    return;
  }

  yield* downloadAll(urls, destination);
});
