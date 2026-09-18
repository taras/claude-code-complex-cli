# Session transcript

Claude Code session `22009af5-fdeb-4ee8-a892-a34b2509abd2` — building `downloadAll()`
on Effection, against a local preview of the Effection documentation site.

Model: Opus 5. Date: 2026-09-18.

---

## 1. Task

> You are building a Node.js CLI that downloads a large collection of files.
>
> Implement:
>
> ```ts
> downloadAll(urls, destination)
> ```
>
> Requirements:
>
> - Download up to 5 files concurrently.
> - Use the standard Promise-based `fetch()` API.
> - Write each response to disk using Node.js APIs.
> - If any download fails, stop all other downloads and propagate the error.
> - If the user presses Ctrl-C, stop all downloads in progress.
> - Partially written files must be deleted when their download is interrupted or fails.
> - Print progress as each file completes.
> - The command must not exit while any download or cleanup operation is still running.
>
> Before implementing, read the current Effection project material starting here:
>
> http://localhost:8000
>
> Follow links from that site when they appear relevant, including its AI-agent
> resources and API documentation. Treat the local site as the authoritative version
> for this exercise. Do not independently switch to another Effection preview or the
> production documentation. If the local site links to an externally hosted agent
> resource, you may follow that link.
>
> Important constraints:
>
> - Do not inspect the local documentation site's source files, Git history, pull
>   requests, or change descriptions.
> - Do not infer Effection APIs from other concurrency libraries.
> - Do not invent Effection APIs.
> - Prefer documented Effection idioms over custom lifecycle abstractions.
> - You may use ordinary Node.js knowledge freely.
> - Do not inspect Effection's implementation source unless the public documentation
>   proves insufficient.
> - Do not experimentally probe undocumented Effection behavior before producing your
>   first implementation. The purpose of the first pass is to determine whether the
>   published material is sufficient.
> - You may and should run the completed program and write tests for its observable
>   behavior.
>
> After implementing it:
>
> 1. Test successful downloads.
> 2. Test that concurrency never exceeds 5.
> 3. Test failure of one download while others are active.
> 4. Test Ctrl-C while downloads are active.
> 5. Verify that no partial files remain after failure or interruption.
> 6. Verify that no network or filesystem work continues after shutdown has completed.
>
> Then report:
>
> - the final implementation;
> - which Effection concepts and APIs you used;
> - exactly where in the Effection material you learned each non-obvious
>   Effection-specific fact;
> - anything you had to infer rather than learn directly;
> - anything you could not determine from the documentation;
> - any documentation that was misleading, incorrect, or missing;
> - any implementation you initially considered but rejected after finding a
>   documented Effection idiom.

---

## 2. Research phase

No code was written until this phase completed. Eight fetches total.

### 2.1 Homepage

`GET http://localhost:8000` — the page's `<head>` advertises an LLM-oriented
document:

```html
<link rel="alternate" type="text/plain" href="/llms.txt" title="LLM Documentation">
```

### 2.2 `llms.txt` — the routing table

This turned out to be the highest-leverage document on the site. Relevant excerpts:

```
## IMPORTANT FOR AI AGENTS

If you will write, modify, refactor, or debug Effection code, you must
read [AGENTS.md] first.

**AGENTS.md is the normative behavioral contract.**
- Do not invent APIs
- Do not infer semantics from Promises or other ecosystems
- Do not substitute primitives that "look equivalent"
- If information is missing or uncertain, consult the API reference

If any other document conflicts with AGENTS.md, **AGENTS.md takes precedence**.
```

It also carries the EffectionX catalog, which is where the concurrency limiter was
found:

```
### Concurrency
- [@effectionx/task-buffer]: Limit concurrent task execution with automatic queuing
```

Note: `llms.txt` routes AGENTS.md and all seven guides to
`raw.githubusercontent.com/thefrontside/effection/v4/...` rather than to local paths.
Only the API reference and the EffectionX pages are served locally. The task prompt
permitted following an externally hosted agent resource, so this was followed.

### 2.3 AGENTS.md (503 lines)

The normative contract. The rules that ended up load-bearing in the implementation:

**On `ensure()` vs `finally`:**

> **Cleanup that needs `yield*` must use `ensure()`, not a `finally` block.**
>
> When a task is halted, a coroutine is unwound by calling `iterator.return()` on its
> generator. If a `finally` block then yields, the generator suspends _inside_ the
> finally and reports `{ done: false }`, so the routine resumes it with
> `iterator.next()` — and that takes the frame out of return-mode. The frame is no
> longer unwinding, so once cleanup finishes, execution continues past the operation
> that was being halted. The halt is lost.

**On destructor ordering:**

> Scope destructors run in **reverse order of registration**. Register the `ensure()`
> where the `try {` would have been — after any `spawn()` calls its cleanup depends
> on — so cleanup still runs while those children are alive.

**On `ensure()` and scope boundaries:**

> `ensure()` registers on the **current scope**, and `call()` does not create one — it
> delegates to the target's iterator in the same coroutine frame. An `ensure()` inside
> `call(function* () { ... })` attaches to the _enclosing task's_ scope and fires far
> too late. Use `scoped()` or `spawn()` when you need a boundary. Note that
> `scoped()`'s own async teardown was not correct until 4.1, so code supporting older
> versions should prefer `spawn()`.

**On `until()`** — the full text, which matters for §5 below:

> - `until(promise)` adapts an already-created `Promise` into an `Operation`.
> - Prefer `until(promise)` over `call(() => promise)` when you have a promise—it is
>   shorter and clearer.
> - It does not make the promise cancellable; for cancellable interop, prefer
>   `useAbortSignal()` with APIs that accept `AbortSignal`.

**On streams:**

> - You must not use `for await` inside a generator function. Use `stream()` to adapt
>   the async iterable, then `each()` to iterate.
> - You must call `yield* each.next()` exactly once at the end of every loop iteration.

### 2.4 Guides

Fetched `thinking-in-effection`, `async-rosetta-stone`, `operations`, `scope`,
`resources`, `spawn`, `collections`.

`docs/spawn.mdx` supplied the failure model:

```
+-- main [FAILED]
  |
  +-- fetchWeekDay('est') [HALTED]
  |
  +-- fetchWeekDay('cet') [FAILED]
```

> An error in a child will also cause the parent to error, which in turn halts any
> siblings.

### 2.5 API reference

`/api/v4/main` — this is what removed the entire Ctrl-C requirement:

> Additionally, handlers for SIGINT are attached to the process, so that sending an
> exit signal to it causes the main task to become halted. This means that hitting
> CTRL-C on an Effection program using `main` will cause an orderly shutdown and run
> all cleanup code.
>
> Warning! do not call `Deno.exit()` on Deno or `process.exit()` on Node directly, as
> this will not gracefully shutdown. Instead, use the `exit` operation.

`/api/v4/useAbortSignal` — the documented example is literally native `fetch`:

```js
function* request() {
  let signal = yield* useAbortSignal();
  return yield* fetch('/some/url', { signal });
}
```

`/x/task-buffer`:

```ts
function useTaskBuffer(max: number): Operation<TaskBuffer>
```

> Create a new TaskBuffer attached to the current scope. It will not allow its number
> of active tasks to exceed `max`.
>
> ```ts
> const buffer = yield* useTaskBuffer(2);
> yield* buffer.spawn(() => sleep(10));
> // will wait for all tasks to be complete
> yield* buffer;
> ```

The page documents queuing only. It says nothing about what happens to a buffered
task that fails, or to queued-but-unstarted work when the scope is halted. Both had
to be inferred and then verified by test.

---

## 3. Project setup

The repo had `node_modules/` containing `effection@4.1.1` but no `package.json`,
`tsconfig.json`, or `.gitignore`. Added all three and installed
`@effectionx/task-buffer@1.3.3`.

First typecheck produced two errors, both TypeScript configuration rather than
Effection:

```
src/download-all.ts(73,42): error TS2345: Argument of type
'ReadableStream<Uint8Array<ArrayBuffer>>' is not assignable to parameter of type
'AsyncIterable<unknown, unknown>'.
  Property '[Symbol.asyncIterator]' is missing ...
```

The DOM lib's `ReadableStream` declaration lacks `Symbol.asyncIterator`; Node's does
have it at runtime. Fixed by dropping `"dom"` from `compilerOptions.lib` and letting
`@types/node` supply the globals.

---

## 4. First implementation

Written in one pass from the documentation, with no structural revision afterwards.

```ts
export function downloadAll(
  urls: string[],
  destination: string,
  options: DownloadAllOptions = {},
): Operation<string[]> {
  let { concurrency = MAX_CONCURRENT_DOWNLOADS, onProgress = report } = options;

  return scoped(function* () {
    yield* until(mkdir(destination, { recursive: true }));

    let buffer = yield* useTaskBuffer(concurrency);
    let paths = urls.map((url, index) => join(destination, filenameFor(url, index)));
    let completed = 0;

    for (let [index, url] of urls.entries()) {
      let path = paths[index];
      yield* buffer.spawn(function* () {
        yield* download(url, path);
        completed++;
        onProgress({ url, path, completed, total: urls.length });
      });
    }

    yield* buffer;

    return paths;
  });
}
```

The per-file download, **as first written** — note the handle/`ensure` ordering,
which is the part that turned out to be wrong:

```ts
  let handle = yield* until(open(path, "w"));
  yield* ensure(function* () {
    yield* until(handle.close());
  });
```

---

## 5. Testing, and the one real defect

Built a local HTTP test server able to stream N chunks with configurable delay and
size, track in-flight and max-in-flight request counts, and record started, finished
and aborted requests.

### 5.1 First run

One failure, caused by my own test regex not accounting for a query string in the
URL (`/fail/bad?delay=60`). The implementation behavior was correct. Fixed the regex.

### 5.2 Mutation checks

Before trusting the suite, each assertion was verified to have teeth by breaking the
implementation on purpose:

| Mutation | Result |
|---|---|
| Remove the partial-file `ensure()` | 4 tests fail |
| Raise the concurrency cap 5 → 10 | concurrency test fails |
| Drop `useAbortSignal()` from `fetch` | 2 halt-related tests fail |

The third is worth noting: without the abort signal, the SIGINT subprocess test still
passed — process exit closes the sockets regardless. Only the in-process halt tests
caught it, via `server.inflight` staying above zero. That is requirement 6 ("no
network work continues after shutdown") doing real work.

### 5.3 The FileHandle leak

A randomized halt-timing stress test was then added — 15 rounds, 10 concurrent
downloads, 256 KiB chunks, halting at a random moment between 20 ms and 80 ms — to
probe the window where a halt lands mid-write.

The assertions passed. The test still failed:

```
✔ leaves nothing behind when halted at arbitrary moments mid-write (3473ms)
ℹ Error: A resource generated asynchronous activity after the test ended. This
  activity created the error "Error: A FileHandle object was closed during garbage
  collection. This used to be allowed with a deprecation warning but is now
  considered an error. Please close FileHandle objects explicitly.
  File descriptor: 27"
```

**Diagnosis.** `until()` abandons a pending promise when the scope is halted. If the
halt lands while `open()` is still in flight, `handle` is never assigned, so the
`ensure()` that closes it is never registered — and the handle that `open()` later
produces is owned by nobody. The file descriptor leaks.

This is invisible in normal operation, invisible in the other five tests, and its
symptom points at Node rather than at Effection.

**Fix.** Register the cleanup against the *promise* rather than the resolved handle,
before yielding on it:

```ts
  // `until()` abandons a pending promise when the scope is halted, so cleanup is
  // registered against the open() promise rather than the handle: otherwise a halt
  // landing while open() is in flight leaks a file descriptor that nothing closes.
  let opening = open(path, "w");
  opening.catch(() => {});
  yield* ensure(function* () {
    yield* until(opening.then((handle) => handle.close(), () => {}));
  });

  let handle = yield* until(opening);
```

**Confirmation.** Reverting only this ordering reproduces the leak; restoring it
eliminates it:

```
=== stress WITHOUT the open fix (expect FileHandle leak) ===
3
=== stress WITH the fix ===
0
```

(counts of `FileHandle object was closed during garbage collection` per run)

### 5.4 Final state

```
✔ downloads files and reports progress
✔ shuts down cleanly on SIGINT, leaving no partial files
✔ downloads every file
✔ never exceeds the concurrency limit
✔ propagates a failure and halts the downloads still in flight
✔ removes partial files and stops work when the enclosing scope is halted
✔ does not queue work that was never reached
✔ leaves nothing behind when halted at arbitrary moments mid-write
ℹ tests 8   ℹ pass 8   ℹ fail 0
```

Three consecutive clean runs, no flakes, no leaked-handle warnings. Typecheck clean.

An end-to-end smoke run against the live local docs site downloaded 8 real pages
concurrently and exited 0.

---

## 6. Report

### Effection concepts and APIs used

| API | Role |
|---|---|
| `main()` | Entry point; installs SIGINT handling |
| `exit()` | Usage-error termination |
| `scoped()` | Boundary so `downloadAll`'s effects don't outlive the call |
| `useTaskBuffer(5)` | Concurrency limit + queuing |
| `ensure()` | Async teardown: close handle, delete partial file |
| `useAbortSignal()` | Binds native `fetch` cancellation to scope |
| `until()` | Adapts `fetch`/`fs.promises` promises into operations |
| `stream()` + `each()` | Consumes the response body's web `ReadableStream` |

### Where each non-obvious fact was learned

- `main()` handles Ctrl-C — `/api/v4/main`, "Deno, Node" section.
- `useTaskBuffer(max)`; `yield* buffer` waits for all — `/x/task-buffer`.
- `useAbortSignal()` for native `fetch` — `/api/v4/useAbortSignal`.
- `ensure()` never `yield*`-in-`finally`, with the `iterator.return()` rationale —
  AGENTS.md `ensure()`.
- Destructors run in reverse registration order — AGENTS.md `ensure()` Gotchas.
- `ensure()` inside `call()` attaches to the enclosing scope — same section.
- `scoped()` for boundary semantics; async teardown correct from 4.1 — AGENTS.md.
- `stream()` + `each()`, `each.next()` exactly once, no `for await` — AGENTS.md.
- A spawn failure halts its siblings — `docs/spawn.mdx`.
- Prefer `until(promise)` over `call(() => promise)` — AGENTS.md `until()`.

### Inferred rather than learned

- `buffer.spawn()` failures propagate like ordinary `spawn()` failures.
- Queued-but-unstarted buffer work is discarded on halt.
- `until()` abandons a pending promise on halt — the docs state only that it "does
  not make the promise cancellable", never what becomes of the in-flight promise.
- Node-side facts used freely: web `ReadableStream` is async-iterable in Node;
  `FileHandle.close()` waits for pending operations.

### Not determinable from the documentation

- Whether `yield* buffer` re-throws a failed task's error or merely waits.
- Whether halting drains or discards queued spawn requests.
- How `ensure()` ordering interacts with child-task teardown, as opposed to
  same-scope registration order.

### Documentation problems found

1. **The significant gap:** nothing warns about the abandoned-promise window around
   `until()`. See §5.3. Every promise-returning resource acquisition adapted via
   `until()` has this hazard.
2. `llms.txt` routes its own normative documents off-site to raw.githubusercontent.com.
3. Rendering bug on every API and EffectionX page — raw Tailwind leaks into prose,
   e.g. `hr]:my-5 [&>p]:mb-0" class="[&>hr]:my-5 [&>p]:mb-0">Create a new TaskBuffer`.
4. `llms.txt` describes `@effectionx/node` as just `"Node."` — truncated.
5. `useTaskBuffer` has no documented error or cancellation semantics.
6. `yield* yield* buffer.spawn(...)` appears in the task-buffer example with no
   explanation; the type is `Operation<Operation<Task<T>>>`.

### Considered and rejected

- Hand-rolled semaphore or chunked `all()` batches → `useTaskBuffer`.
- `try { } finally { yield* cleanup() }` → explicitly unsafe per AGENTS.md.
- A custom "download session" resource → a custom lifecycle abstraction; `ensure()`
  with reverse-order registration does the same job with documented semantics.
- Manual `AbortController` threading → AGENTS.md prefers rewriting in Effection.
- `process.on("SIGINT")` / `process.exit()` → unnecessary and warned against.
- `@effectionx/fetch` → more idiomatic, but the task specified standard `fetch()`.
- `@effectionx/node`'s `fromReadable` → unnecessary; core `stream()` adapts the web
  stream directly.
- `call()` around the body of `downloadAll` → creates no scope boundary, so
  `useTaskBuffer` and `ensure()` would attach to the caller's scope.

---

## 7. Retrospective

The full difficulty assessment — mental model, API discovery, writing code, and
debugging, each split into one-time and recurring cost — is reproduced in the pull
request description for this branch.

Its short form:

- **Mental model:** cheap, one-time, and generative. One recurring sub-question:
  which constructs create a scope.
- **API discovery:** cheap, well-routed by `llms.txt`. Recurring cost is the
  EffectionX catalog scan; skipping it silently produces worse code.
- **Writing the code:** near zero, and the biggest surprise. ~45 lines with no
  lifecycle bookkeeping at all.
- **Debugging:** where the cost actually sat. Three of four problems were
  Node/TypeScript friction. The fourth — the `until()` leak — is structural and will
  recur on any Effection task touching promise-based Node I/O.

Four of the eight requirements — Ctrl-C, halt-siblings-on-failure, don't-exit-during-
cleanup, and the concurrency cap — cost approximately nothing. The only real bug lived
in the requirement that reads as most trivial: "write the response to disk".

**Was the public documentation sufficient?** Sufficient to produce code that looks
correct and passes a reasonable test suite; insufficient to produce code that is
correct. Effection's source was never read (only `task-buffer`'s `.d.ts`, which is
public API surface), and no undocumented behavior was probed before the first pass.

**Smallest missing piece:** roughly five sentences and a snippet appended to the
existing `until()` section of AGENTS.md, stating that a halt abandons a pending
promise and that this leaks any resource the promise acquires, with the
register-cleanup-against-the-promise pattern as the remedy.
