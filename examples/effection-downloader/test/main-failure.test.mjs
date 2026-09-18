import { fileURLToPath } from 'node:url';
const CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
import { spawn } from 'node:child_process';
import { rm, readdir } from 'node:fs/promises';
import { startServer } from './fixture-server.mjs';
const s = await startServer({ chunks: 20, chunkMs: 30, failPath: '/f2.bin' });
await rm('./tmp/out8', { recursive: true, force: true });
const urls = Array.from({length: 8}, (_, i) => `http://127.0.0.1:${s.port}/f${i}.bin`);
const child = spawn(process.execPath, [CLI, './tmp/out8', ...urls], { stdio: ['ignore','pipe','pipe'] });
let out=''; child.stderr.on('data',d=>out+=d);
const [code] = await new Promise(r => child.on('exit', c => r([c])));
const files = await readdir('./tmp/out8').catch(()=>[]);
console.log('exit=%d (docs: error reaching main -> 1) partials=%d errPrinted=%s',
  code, files.filter(f=>f.endsWith('.part')).length, out.includes('500'));
await s.close();
