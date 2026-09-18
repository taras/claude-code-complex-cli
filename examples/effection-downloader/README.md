# effection-downloader

A concurrent file downloader built with [Effection](https://github.com/thefrontside/effection) 4.1.1,
written as a working test of how well Effection handles a realistic long-running
CLI workload.

```
npm install
npm test
node src/cli.mjs ./downloads https://example.com/a.bin https://example.com/b.bin
```

## What it does

`downloadAll(urls, destination)` downloads a collection of files with:

- **at most 5 concurrent downloads** — a worker pool, not a semaphore, because
  Effection core has no bounded-concurrency primitive (`all()` is unbounded and
  `createQueue()` takes no capacity argument)
- **fail-fast**: if any download errors, `all()` halts the remaining workers and
  propagates the first error
- **Ctrl-C cancellation**: `main()` halts the whole operation tree
- **no partial files**: downloads land on a `.part` path and are atomically
  renamed on success; interrupted or failed `.part` files are deleted
- **no premature exit**: the process stays alive until every download and every
  cleanup has finished

## The part that is easy to get wrong

Effection halts *promptly*: it stops driving a generator but lets any foreign
promise keep running, unobserved. `fetch` and `pipeline` are foreign promises,
so cancellation only actually happens if an `AbortSignal` reaches them.

`useAbortSignal()` binds a signal to its scope. The trap is *which* scope. Bind
it to the whole download operation and its abort fires during that operation's
teardown — which is too late if other cleanup registered later needs the
transfer already stopped. The first version of this code did exactly that:

| | shutdown after Ctrl-C | downloads completing *after* the interrupt |
|---|---|---|
| signal bound to the whole operation | **5610 ms** | **9** |
| signal bound to a `scoped()` transfer | **~22 ms** | **0** |

The fix is to wrap the transfer in `scoped()`, whose documented behaviour is
that no effects persist past it. The signal is then aborted when the transfer
block exits — before the enclosing `ensure()` deletes the partial file. That
ordering comes from nesting, which is a documented structural property, rather
than from the order `ensure` callbacks happen to unwind in, which is not
documented anywhere.

## Tests

`npm test` runs every `test/*.test.mjs` against a local fixture server that
serves slow chunked responses.

| File | Checks |
|---|---|
| `happy.test.mjs` | 12 files download; peak concurrency is exactly 5; no `.part` left |
| `failure.test.mjs` | HTTP 500 propagates, siblings halt, zero files left behind |
| `main-failure.test.mjs` | an error reaching `main()` exits 1, per its docs |
| `sigint.test.mjs` | SIGINT mid-flight: exit 130, fast shutdown, no partials |
| `stress.test.mjs` | the same, interrupted at 6 different points |
| `edge.test.mjs` | empty URL list |
| `docs-claims.test.mjs` | two claims made by Effection's own JSDoc |

## Two documentation bugs found in 4.1.1

`docs-claims.test.mjs` pins both.

1. **`useAbortSignal`'s JSDoc example does not run.** It shows
   `return yield* fetch('/some/url', { signal })`, which throws
   `TypeError: ... is not iterable` — promises are not iterable. It needs
   `until(fetch(...))` or `call(() => fetch(...))`. This is the one example a
   newcomer would copy for precisely this use case, and it also leaks an
   unhandled rejection.
2. **`all`'s JSDoc example uses a removed API** — `expect(fetch(...))`. `expect`
   is not exported in 4.1.1; it was the v3 promise bridge, superseded by
   `until` in 3.4.

## Known limitations

- Duplicate URL basenames collide on the same output path.
- No per-download timeout or retry.
- Teardown has no time bound; a hung cleanup hangs shutdown. The documented
  escape hatch is Effection's `exit()` operation, never `process.exit()`.
- **Only tested on Linux.** The cleanup unlinks a `.part` file whose descriptor
  may not be closed yet. POSIX tolerates that; Windows would fail with EBUSY and
  leave the partial file behind.
