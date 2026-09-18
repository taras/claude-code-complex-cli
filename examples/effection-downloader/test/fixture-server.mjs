import { createServer } from 'node:http';
// Serves slow, chunked bodies so downloads stay in flight long enough to interrupt.
export function startServer({ failPath = null, chunks = 10, chunkMs = 40 } = {}) {
  let live = 0, peak = 0;
  const server = createServer(async (req, res) => {
    live++; peak = Math.max(peak, live);
    const done = () => { live--; };
    req.on('aborted', done); res.on('close', done);
    if (req.url === failPath) { res.writeHead(500); res.end('nope'); return; }
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    for (let i = 0; i < chunks; i++) {
      if (res.writableEnded || res.destroyed) return;
      res.write('x'.repeat(1024));
      await new Promise(r => setTimeout(r, chunkMs));
    }
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port,
      peak: () => peak,
      close: () => new Promise(r => server.close(r)),
    }));
  });
}
