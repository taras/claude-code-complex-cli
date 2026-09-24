#!/usr/bin/env node
import { downloadAll } from "../src/downloadAll.ts";

const [destination, ...urls] = process.argv.slice(2);

if (!destination || urls.length === 0) {
  console.error("usage: download-all <destination> <url...>");
  process.exit(1);
}

await downloadAll(urls, destination);
