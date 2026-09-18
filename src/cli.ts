#!/usr/bin/env node
import { exit, main, type Operation, until } from "effection";
import { readFile } from "node:fs/promises";
import {
  downloadAll,
  MAX_CONCURRENT_DOWNLOADS,
} from "./download-all.js";

const usage = `usage: downloadall [options] <destination> [url...]

options:
  --from <file>         read newline separated urls from <file>
  --concurrency <n>     downloads in flight at once (default ${MAX_CONCURRENT_DOWNLOADS})
`;

await main(function* (args: string[]): Operation<void> {
  let destination: string | undefined;
  let from: string | undefined;
  let concurrency = MAX_CONCURRENT_DOWNLOADS;
  const urls: string[] = [];

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;

    if (arg === "--help" || arg === "-h") {
      console.log(usage);
      yield* exit(0);
    } else if (arg === "--from") {
      from = args[++index];
      if (from === undefined) {
        yield* exit(1, `--from requires a file\n\n${usage}`);
      }
    } else if (arg === "--concurrency") {
      const value = Number(args[++index]);
      if (!Number.isInteger(value) || value < 1) {
        yield* exit(1, `--concurrency requires a positive integer\n\n${usage}`);
      }
      concurrency = value;
    } else if (arg.startsWith("-")) {
      yield* exit(1, `unknown option: ${arg}\n\n${usage}`);
    } else if (destination === undefined) {
      destination = arg;
    } else {
      urls.push(arg);
    }
  }

  if (destination === undefined) {
    yield* exit(1, `a destination directory is required\n\n${usage}`);
    return;
  }

  if (from !== undefined) {
    const contents = yield* until(readFile(from, "utf8"));
    for (const line of contents.split("\n")) {
      const url = line.trim();
      if (url !== "" && !url.startsWith("#")) {
        urls.push(url);
      }
    }
  }

  if (urls.length === 0) {
    yield* exit(1, `at least one url is required\n\n${usage}`);
  }

  yield* downloadAll(urls, destination, { concurrency });

  console.log(`downloaded ${urls.length} files to ${destination}`);
});
