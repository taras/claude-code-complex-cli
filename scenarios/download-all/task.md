Implement a Node.js TypeScript CLI function:

    downloadAll(urls, destination)

Requirements:

- Download every URL into `destination`.
- Run no more than five downloads concurrently.
- Use the standard Promise-based `fetch()` API for HTTP.
- Use Node.js APIs to write files.
- If one download fails, stop the remaining work and propagate the error.
- Ctrl-C must stop all active and queued work.
- Remove partial files during failure or cancellation.
- Report progress while downloads run.
- Do not return or exit while network activity, filesystem activity, or required cleanup is still running.

## Documentation

Before implementing anything, start with:

    http://localhost:8000/llms.txt

Use the local website as the authoritative documentation for this task.

Follow its local documentation links. Do not use production documentation, preview deployments, GitHub documentation or PRs, search results, or previously cached Effection information.

If `llms.txt` points off localhost, use the corresponding local page if one exists and report the routing problem.

Do not inspect Effection or EffectionX implementation source, tests, Git history, branches, or pull requests before completing the first implementation.

Do not invent APIs or preemptively add workarounds for hypothetical package behavior. Implement according to the documented guarantees. If verification later contradicts those guarantees, report and investigate the contradiction.

## Dependencies

Use the same physical Effection installation as the local EffectionX checkout:

    pnpm add "effection@link:/Users/tarasmankovski/Repositories/frontside/effectionx/node_modules/effection"

You may use any EffectionX package you discover through the local documentation.

Do not install `@effectionx/*` packages from npm. Install each selected package with:

    pnpm add "@effectionx/<package>@link:/Users/tarasmankovski/Repositories/frontside/effectionx/<package>"

Run application and test code with the `development` export condition:

    node --conditions=development ...

Before relying on a linked package, verify its resolution:

    node --conditions=development --input-type=module -e "console.log(import.meta.resolve('@effectionx/<package>'))"

It must resolve inside:

    /Users/tarasmankovski/Repositories/frontside/effectionx

The local dependency checkout is frozen for this evaluation. Do not update, build, edit, or switch branches in it.

## Process

1. Read the local documentation.
2. Implement a complete first version without inspecting library source or probing undocumented behavior.
3. Test:
   - successful downloads;
   - the five-download concurrency limit;
   - failure while other work is active and queued;
   - explicit halt;
   - real Ctrl-C/SIGINT;
   - removal of partial files;
   - no queued work starting after shutdown begins;
   - no network or filesystem activity after shutdown completes.
4. Only after the first implementation, debug any behavior contradicted by those tests.

Keep the implementation focused. Do not add unrelated abstractions or features.

## Final report

Report:

- documentation pages used, in order;
- EffectionX packages considered and why each was accepted or rejected;
- installed packages and their resolved local paths;
- behavior taken directly from documentation;
- behavior inferred or defined by the application;
- documentation or package behavior contradicted by testing;
- whether implementation source was inspected after the first implementation;
- verification commands and results.
