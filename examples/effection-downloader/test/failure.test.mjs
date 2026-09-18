import { run } from 'effection';
import { readdir, rm } from 'node:fs/promises';
import { startServer } from './fixture-server.mjs';
import { downloadAll } from '../src/downloadAll.mjs';
const dest = './tmp/out2';
await rm(dest, { recursive: true, force: true });
const s = await startServer({ chunks: 30, chunkMs: 40, failPath: '/f3.bin' });
const urls = Array.from({ length: 12 }, (_, i) => `http://127.0.0.1:${s.port}/f${i}.bin`);
let err = null;
try { await run(() => downloadAll(urls, dest)); } catch (e) { err = e; }
await new Promise(r => setTimeout(r, 300)); // give any stragglers a chance to misbehave
const files = (await readdir(dest)).sort();
console.log('RESULT error=%o files=%j', err && err.message, files);
console.log('PASS:', !!err && err.message.includes('500') && files.length === 0);
await s.close();
