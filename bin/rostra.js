#!/usr/bin/env node
// Keep node:sqlite's "experimental" notice off the terminal; other warnings still show.
process.removeAllListeners("warning").on("warning", (w) => {
  if (w.name === "ExperimentalWarning" && /SQLite/i.test(w.message)) return;
  process.stderr.write(`${w.name}: ${w.message}\n`);
});
const { run } = await import("../src/cli.js");
const code = await run(process.argv.slice(2));
if (code >= 0) process.exitCode = code;
