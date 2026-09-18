# downloadall

A Node.js CLI that downloads a large collection of files, written with
[Effection](https://frontside.com/effection) structured concurrency.

```
downloadall [options] <destination> [url...]

options:
  --from <file>         read newline separated urls from <file>
  --concurrency <n>     downloads in flight at once (default 5)
```

```ts
import { downloadAll } from "./src/download-all.js";

yield* downloadAll(urls, "./downloads");
```

## Behaviour

- at most five downloads run concurrently (`@effectionx/task-buffer`)
- progress is printed as each file completes
- a failed download halts the downloads still running and raises the error
- `Ctrl-C` halts every download in progress and exits with code 130
- a file that was interrupted or failed mid-write is deleted, and the deletion
  happens before the process exits
- no request and no write survives shutdown: the `fetch()` of each download is
  bound to that download's scope, and the file descriptor is closed by the
  scope that opened it

## Development

```
npm install
npm test     # builds, then runs the node:test suite
```
