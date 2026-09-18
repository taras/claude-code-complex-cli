import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { run, sleep, spawn } from "effection";
import { downloadAll } from "../src/download-all.ts";
import { startServer, type TestServer } from "./server.ts";

describe("shutdown stress", () => {
  let server: TestServer;

  before(async () => {
    server = await startServer();
  });
  after(async () => {
    await server.close();
  });

  it("leaves nothing behind when halted at arbitrary moments mid-write", async () => {
    // 256KiB chunks make a write genuinely likely to be in flight at halt time.
    for (let round = 0; round < 15; round++) {
      let dest = await mkdtemp(join(tmpdir(), `stress-${round}-`));
      let urls = Array.from(
        { length: 10 },
        (_, i) => server.url(`/file/s${round}-${i}?chunks=40&delay=5&size=262144`),
      );

      await run(function* () {
        let task = yield* spawn(() => downloadAll(urls, dest, { onProgress: () => {} }));
        yield* sleep(20 + Math.floor(Math.random() * 60));
        yield* task.halt();
      });

      assert.deepEqual(await readdir(dest), [], `round ${round}: dir not empty right after halt`);

      await delay(150);

      assert.deepEqual(await readdir(dest), [], `round ${round}: a file reappeared after halt`);
      assert.equal(server.inflight, 0, `round ${round}: request still in flight after halt`);
    }
  });
});
