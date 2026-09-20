import { main } from "effection";
import { downloadAll } from "../src/download-all.ts";

const [base, destination] = process.argv.slice(2);

const urls = Array.from({ length: 20 }, (_, i) => `${base}/partial/s${i}.bin`);

await main(function* () {
  yield* downloadAll(urls, destination);
});
