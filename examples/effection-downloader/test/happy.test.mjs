import { run } from 'effection';
import { readdir, rm } from 'node:fs/promises';
import { startServer } from './fixture-server.mjs';
import { downloadAll } from '../src/downloadAll.mjs';
const dest = './tmp/out1';
await rm(dest, { recursive: true, force: true });
const s = await startServer({ chunks: 4, chunkMs: 20 });
const urls = Array.from({ length: 12 }, (_, i) => `http://127.0.0.1:${s.port}/f${i}.bin`);
const n = await run(() => downloadAll(urls, dest));
const files = (await readdir(dest)).sort();
console.log('RESULT completed=%d files=%d partials=%d peakConcurrency=%d',
  n, files.length, files.filter(f => f.endsWith('.part')).length, s.peak());
console.log('PASS:', n === 12 && files.length === 12 && s.peak() <= 5 && s.peak() > 1);
await s.close();
