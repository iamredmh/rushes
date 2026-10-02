#!/usr/bin/env node
import { main } from "./main.js";

const code = await main(process.argv.slice(2), {
  out: (l) => console.log(l),
  err: (l) => console.error(l),
  cwd: process.cwd(),
});
// open, serve and mcp keep running on their own handles; everything else exits.
const [cmd] = process.argv.slice(2);
if (!["open", "serve", "mcp"].includes(cmd ?? "") || code !== 0) process.exit(code);
