// Probes of two claims made by Effection 4.1.1's own JSDoc.
import { run, scoped, useAbortSignal } from 'effection';
import { startServer } from './fixture-server.mjs';

// The broken example below constructs a fetch() promise that nothing ever
// observes; when its signal aborts it rejects with no handler attached. That
// leaked rejection is part of the finding, so swallow it rather than let it
// take the process down with exit code 1.
const leaked = [];
process.on('unhandledRejection', (e) => leaked.push(e));

// CLAIM (scoped JSDoc): effects do not persist outside a scoped block, so an
// AbortSignal created inside one is aborted on exit. -> holds.
await run(function* () {
  const signal = yield* scoped(function* () { return yield* useAbortSignal(); });
  console.log('scoped() aborts its signal on exit:', signal.aborted === true ? 'PASS' : 'FAIL');
});

// CLAIM (useAbortSignal JSDoc): `return yield* fetch(url, { signal })`.
// -> does NOT hold. Promises are not iterable, so this throws. Use until().
const s = await startServer({ chunks: 1, chunkMs: 1 });
let threw = null;
try {
  await run(function* () {
    const signal = yield* useAbortSignal();
    yield* fetch(`http://127.0.0.1:${s.port}/a.bin`, { signal });
  });
} catch (e) { threw = e; }
console.log('useAbortSignal JSDoc example is broken:',
  threw && /not iterable/.test(threw.message) ? 'PASS (documented example throws)' : 'FAIL');
await s.close();

// give the abandoned fetch a moment to reject, then report it
await new Promise((r) => setTimeout(r, 100));
console.log('leaked unhandled rejections from the broken example:', leaked.length);
