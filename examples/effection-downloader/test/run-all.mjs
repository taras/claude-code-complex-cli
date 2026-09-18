import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readdirSync } from 'node:fs';

const dir = fileURLToPath(new URL('.', import.meta.url));
const files = readdirSync(dir).filter(f => f.endsWith('.test.mjs')).sort();
let failed = 0;

for (const f of files) {
  process.stdout.write(`\n=== ${f} ===\n`);
  const r = spawnSync(process.execPath, [dir + f], { stdio: 'inherit', cwd: dir + '..' });
  if (r.status !== 0) { failed++; console.error(`!! ${f} exited ${r.status}`); }
}
console.log(`\n${files.length - failed}/${files.length} test files completed cleanly`);
process.exit(failed ? 1 : 0);
