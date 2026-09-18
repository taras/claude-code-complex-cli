import { fileURLToPath } from 'node:url';
const CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
import { spawn } from 'node:child_process';
import { readdir, rm, stat } from 'node:fs/promises';
import { startServer } from './fixture-server.mjs';
const s = await startServer({ chunks: 40, chunkMs: 30 });
let allPass = true;
for (let run = 0; run < 6; run++) {
  const dest = `./tmp/stress${run}`;
  await rm(dest, { recursive: true, force: true });
  const urls = Array.from({ length: 20 }, (_, i) => `http://127.0.0.1:${s.port}/f${i}.bin`);
  const child = spawn(process.execPath, [CLI, dest, ...urls], { stdio: ['ignore','pipe','pipe'] });
  let out=''; child.stdout.on('data',d=>out+=d); child.stderr.on('data',d=>out+=d);
  await new Promise(r => setTimeout(r, 200 + run * 130));   // interrupt at varying points
  const t0 = Date.now();
  child.kill('SIGINT');
  const [code] = await new Promise(r => child.on('exit', (c) => r([c])));
  const ms = Date.now() - t0;
  // snapshot sizes, wait, snapshot again: did anything write AFTER exit?
  const snap = async () => Object.fromEntries(await Promise.all(
    (await readdir(dest).catch(()=>[])).map(async f => [f, (await stat(`${dest}/${f}`)).size])));
  const a = await snap();
  await new Promise(r => setTimeout(r, 600));
  const b = await snap();
  const grew = JSON.stringify(a) !== JSON.stringify(b);
  const partials = Object.keys(b).filter(f => f.endsWith('.part'));
  const ok = code === 130 && partials.length === 0 && !grew && ms < 1000;
  if (!ok) allPass = false;
  console.log(`run ${run}: exit=${code} ms=${ms} files=${Object.keys(b).length} partials=${partials.length} wroteAfterExit=${grew} ${ok?'OK':'*** FAIL ***'}`);
  await rm(dest, { recursive: true, force: true });
}
console.log('STRESS PASS:', allPass);
await s.close();
