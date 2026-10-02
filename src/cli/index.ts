#!/usr/bin/env node
import { longRunningCommand, main } from "./main.js";

const argv = process.argv.slice(2);
const code = await main(argv, {
  out: (l) => console.log(l),
  err: (l) => console.error(l),
  cwd: process.cwd(),
});
// open, serve and mcp keep running on their own handles; everything else exits.
if (!longRunningCommand(argv) || code !== 0) process.exit(code);
