import { fileURLToPath } from 'node:url';
const CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
import { spawn } from 'node:child_process';
import { readdir, rm } from 'node:fs/promises';
import { startServer } from './fixture-server.mjs';
const dest = './tmp/out3';
await rm(dest, { recursive: true, force: true });
const s = await startServer({ chunks: 40, chunkMs: 50 });
const urls = Array.from({ length: 12 }, (_, i) => `http://127.0.0.1:${s.port}/f${i}.bin`);
const child = spawn(process.execPath, [CLI, dest, ...urls], { stdio: ['ignore','pipe','pipe'] });
let out = ''; child.stdout.on('data', d => out += d); child.stderr.on('data', d => out += d);
await new Promise(r => setTimeout(r, 600));
const t0 = Date.now();
child.kill('SIGINT');
const [code] = await new Promise(r => child.on('exit', (c, sg) => r([c, sg])));
const elapsed = Date.now() - t0;
await new Promise(r => setTimeout(r, 500));
let files = []; try { files = (await readdir(dest)).sort(); } catch {}
const partials = files.filter(f => f.endsWith('.part'));
console.log('exit=%o  shutdown=%dms  completed-before-ctrlc=%d  partials-left=%d',
  code, elapsed, files.length, partials.length);
console.log('PASS:', code === 130 && partials.length === 0 && elapsed < 1000 && !out.includes('ALL DONE'));
await s.close();
