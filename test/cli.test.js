import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../src/cli.js";
import { memStore, mockFetch, musedinRoutes, BASE } from "./helpers.js";

function cli(store = memStore()) {
  const lines = [];
  const errs = [];
  const go = async (...argv) => {
    lines.length = 0;
    errs.length = 0;
    const code = await run(argv, { store, out: (s) => lines.push(s), err: (s) => errs.push(s), importOptions: { fetch: mockFetch(musedinRoutes()), base: BASE } });
    return { code, out: lines.join("\n"), err: errs.join("\n") };
  };
  return { go, store };
}

test("commands in process", async () => {
  const { go, store } = cli();
  assert.match((await go("add", "Vela", "Bot", "--skills", "python,testing")).out, /^added ag_\w+ Vela Bot$/);
  const id = store.listAgents()[0].id;
  assert.match((await go("list")).out, /Vela Bot/);
  assert.equal(JSON.parse((await go("list", "--json")).out)[0].id, id);
  assert.match((await go("update", id, "--status", "active", "--note", "met")).out, /updated/);
  const imp = await go("import", "agent_abc123xyz0");
  assert.equal(imp.code, 0);
  assert.match(imp.out, /imported ag_\w+ Spore from musedin: 3 skills, 3 engagements added/);
  assert.match((await go("import", "agent_abc123xyz0")).out, /^refreshed/);
  assert.match((await go("show", "agent_abc123xyz0")).out, /Spore[\s\S]*engagements 3[\s\S]*paid/);
  const e = await go("engage", id, "Write", "a", "client", "--stage", "hired", "--amount", "5 USDC");
  const eid = /logged (en_\w+)/.exec(e.out)[1];
  assert.match((await go("move", eid, "paid")).out, /now paid/);
  const f = await go("follow", id, "2026-10-20", "Offer", "more");
  const fid = /follow-up (fu_\w+)/.exec(f.out)[1];
  assert.match((await go("followups")).out, /Offer more/);
  assert.match((await go("done", fid)).out, /done/);
  assert.equal((await go("followups")).out, "no follow-ups");
  assert.match((await go("pipeline")).out, /hired 1 · delivered 0 · accepted 0 · paid 3 \(5\.5 USD, 5 USDC\)/);
});

test("errors and usage", async () => {
  const { go } = cli();
  const r = await go("show", "nobody");
  assert.equal(r.code, 1);
  assert.match(r.err, /no agent nobody/);
  assert.equal((await go("engage", "x")).code, 1);
  assert.equal((await go("frobnicate")).code, 2);
  assert.equal((await go("list", "--bogus")).code, 2);
  assert.match((await go("help")).out, /agent resource management/);
});

test("the bin runs and writes a database file", () => {
  const dir = mkdtempSync(join(tmpdir(), "rostra-cli-"));
  try {
    const db = join(dir, "r.db");
    const bin = fileURLToPath(new URL("../bin/rostra.js", import.meta.url));
    const add = spawnSync(process.execPath, [bin, "--db", db, "add", "Tarn"], { encoding: "utf8" });
    assert.equal(add.status, 0, add.stderr);
    assert.equal(add.stderr, "", "no experimental warning");
    const list = spawnSync(process.execPath, [bin, "--db", db, "list", "--json"], { encoding: "utf8" });
    assert.equal(JSON.parse(list.stdout)[0].name, "Tarn");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
