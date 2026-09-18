You are building a Node.js CLI that downloads a large collection of files.

Implement:

```ts
downloadAll(urls, destination)
```

Requirements:

- Download up to 5 files concurrently.
- Use the standard Promise-based `fetch()` API.
- Write each response to disk using Node.js APIs.
- If any download fails, stop all other downloads and propagate the error.
- If the user presses Ctrl-C, stop all downloads in progress.
- Partially written files must be deleted when their download is interrupted or fails.
- Print progress as each file completes.
- The command must not exit while any download or cleanup operation is still running.

Before implementing, read the current Effection project material starting here:

http://localhost:8000

Follow links from that site when they appear relevant, including its AI-agent resources and API documentation. Treat the local site as the authoritative version for this exercise. Do not independently switch to another Effection preview or the production documentation. If the local site links to an externally hosted agent resource, you may follow that link.

Important constraints:

- Do not inspect the local documentation site’s source files, Git history, pull requests, or change descriptions.
- Do not infer Effection APIs from other concurrency libraries.
- Do not invent Effection APIs.
- Prefer documented Effection idioms over custom lifecycle abstractions.
- You may use ordinary Node.js knowledge freely.
- Do not inspect Effection’s implementation source unless the public documentation proves insufficient.
- Do not experimentally probe undocumented Effection behavior before producing your first implementation. The purpose of the first pass is to determine whether the published material is sufficient.
- You may and should run the completed program and write tests for its observable behavior.

After implementing it:

1. Test successful downloads.
2. Test that concurrency never exceeds 5.
3. Test failure of one download while others are active.
4. Test Ctrl-C while downloads are active.
5. Verify that no partial files remain after failure or interruption.
6. Verify that no network or filesystem work continues after shutdown has completed.

Then report:

- the final implementation;
- which Effection concepts and APIs you used;
- exactly where in the Effection material you learned each non-obvious Effection-specific fact;
- anything you had to infer rather than learn directly;
- anything you could not determine from the documentation;
- any documentation that was misleading, incorrect, or missing;
- any implementation you initially considered but rejected after finding a documented Effection idiom.
