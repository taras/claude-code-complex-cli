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

Follow only links whose origin is `http://localhost:8000`. Do not use:

- frontside.com;
- Netlify previews;
- production documentation;
- GitHub documentation or PRs;
- search-engine results;
- previously cached Effection documentation.

For the Effection agent rules, read only:

    /Users/tarasmankovski/Repositories/frontside/effection/AGENTS.md

Do not inspect Effection or EffectionX implementation source, tests, Git history, branches, or pull requests before your first implementation. The local EffectionX directory described below is provided only as a dependency source.

Do not invent APIs. If a relevant behavior is not documented, identify that gap instead of assuming it.

## Local EffectionX packages

You may use any EffectionX package you discover through the local documentation.

Do not install any `@effectionx/*` package from npm.

For each `@effectionx/<package>` dependency you choose, install it from:

    /Users/tarasmankovski/Repositories/frontside/effectionx/<package>

With pnpm, use this form:

    pnpm add "@effectionx/<package>@link:/Users/tarasmankovski/Repositories/frontside/effectionx/<package>"

The linked packages expose their current source through the `development` export condition. Run every command that executes application or test code with that condition enabled, for example:

    node --conditions=development --test
    node --conditions=development path/to/program.ts

You may instead set:

    NODE_OPTIONS=--conditions=development

Before relying on a linked package, verify its resolution with:

    node --conditions=development --input-type=module -e "console.log(import.meta.resolve('@effectionx/<package>'))"

The result must point inside:

    /Users/tarasmankovski/Repositories/frontside/effectionx

Do not replace the local dependency with an npm version before finishing.

## Process

1. Read the local documentation.
2. Implement a complete first version without inspecting library source or experimentally reverse-engineering undocumented behavior.
3. Then run focused tests covering:
   - successful downloads;
   - the five-download concurrency limit;
   - one download failing while others are active or queued;
   - Ctrl-C or explicit halt;
   - removal of partial files;
   - no network or filesystem activity after shutdown completes.
4. Debug normally after the first implementation if tests expose a problem.

Keep the implementation focused. Do not add unrelated abstractions or features.

## Final report

Report:

- the documentation pages used;
- every EffectionX package considered;
- every EffectionX package installed;
- the resolved local path for each installed package;
- which behavior came directly from documentation;
- which behavior had to be inferred;
- any missing or ambiguous documentation;
- the verification commands and results.