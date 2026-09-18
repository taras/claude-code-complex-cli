import { main } from 'effection';
import { downloadAll } from './downloadAll.mjs';
const [dest, ...urls] = process.argv.slice(2);
await main(function* () {
  yield* downloadAll(urls, dest);
  console.log('ALL DONE');
});
