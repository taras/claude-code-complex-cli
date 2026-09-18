import { run } from 'effection';
import { downloadAll } from '../src/downloadAll.mjs';
console.log('empty:', await run(() => downloadAll([], './tmp/out4')));
