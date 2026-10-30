// Tests for the musedin-record importer: an agent imported by muse_id from
// GET /api/muse/<id>/record, using a saved sample answer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { mapMusedInRecord } from "../src/importers/musedin-record.js";
import { importAgent, importerFor } from "../src/importers/index.js";
import { RostraError } from "../src/store.js";
import { memStore, mockFetch, BASE } from "./helpers.js";
import { run } from "../src/cli.js";

const SAMPLE = JSON.parse(readFileSync(new URL("./fixtures/musedin-record-sample.json", import.meta.url), "utf8"));
const RECORD = JSON.parse(SAMPLE.payload);

const recordRoutes = (id = "agent_sample0001", body = SAMPLE) => ({
  [`/api/muse/${id}/record`]: [200, body],
});

test("musedin-record is registered and matches MusedIn ids", () => {
  const imp = importerFor("agent_sample0001", "musedin-record");
  assert.equal(imp.name, "musedin-record");
  assert.equal(imp.match("agent_sample0001"), true);
  assert.equal(imp.match("https://musedin.com/m/agent_sample0001"), true);
  assert.throws(() => importerFor("agent_sample0001", "no-such-source"), RostraError);
});

test("mapMusedInRecord maps the record's hires, skips declined", () => {
  const { agent, engagements, counts } = mapMusedInRecord("agent_sample0001", RECORD, BASE);
  assert.equal(agent.name, "Spore");
  assert.equal(agent.source, "musedin");
  assert.equal(agent.source_ref, "agent_sample0001");
  assert.equal(agent.profile_url, `${BASE}/m/agent_sample0001`);
  assert.deepEqual(counts, { delivered: 1, hires: 3, receipts: 0, verified: true });
  assert.equal(engagements.length, 3, "declined hire left out");
  const byRef = Object.fromEntries(engagements.map((e) => [e.source_ref, e]));
  assert.equal(byRef["musedin:hire:101"].stage, "delivered");
  assert.deepEqual(byRef["musedin:hire:101"].evidence, ["https://musedin.com/api/record/hire/101", "https://musedin.com/p/555"]);
  assert.equal(byRef["musedin:hire:102"].stage, "hired");
  assert.equal(byRef["musedin:hire:104"].stage, "paid");
  assert.equal(byRef["musedin:hire:104"].amount, "4.00 USD");
  assert.equal(byRef["musedin:hire:103"], undefined);
});

test("import --source musedin-record reads only the record endpoint and saves", async () => {
  const s = memStore();
  const calls = [];
  const r = await importAgent(s, "agent_sample0001", { fetch: mockFetch(recordRoutes(), calls), base: BASE, source: "musedin-record" });
  assert.deepEqual(calls.map((c) => c.url), [`${BASE}/api/muse/agent_sample0001/record`]);
  assert.equal(r.source, "musedin-record");
  assert.equal(r.created, true);
  assert.equal(r.agent.name, "Spore");
  assert.equal(r.engagements_added, 3);
  // Second import refreshes the same agent, adds nothing.
  const again = await importAgent(s, "agent_sample0001", { fetch: mockFetch(recordRoutes()), base: BASE, source: "musedin-record" });
  assert.equal(again.created, false);
  assert.equal(again.agent.id, r.agent.id);
  assert.equal(again.engagements_added, 0);
  assert.equal(s.listAgents().length, 1);
});

test("import command accepts --source musedin-record", async () => {
  const store = memStore();
  const lines = [];
  const code = await run(["import", "agent_sample0001", "--source", "musedin-record"], {
    store,
    out: (s) => lines.push(s),
    err: () => {},
    importOptions: { fetch: mockFetch(recordRoutes()), base: BASE },
  });
  assert.equal(code, 0);
  assert.match(lines.join("\n"), /imported ag_\w+ Spore from musedin-record: 0 skills, 3 engagements added/);
});

test("record errors become RostraErrors and write nothing", async () => {
  const s = memStore();
  await assert.rejects(importAgent(s, "muse_nobody0000", { fetch: mockFetch({}), base: BASE, source: "musedin-record" }), (e) => e.status === 404);
  await assert.rejects(
    importAgent(s, "agent_sample0001", { fetch: mockFetch({ "/api/muse/agent_sample0001/record": [200, { ok: true, payload: "{not json" }] }), base: BASE, source: "musedin-record" }),
    (e) => e.status === 502,
  );
  await assert.rejects(
    importAgent(s, "agent_sample0001", { fetch: mockFetch({ "/api/muse/agent_sample0001/record": [200, { ok: true, payload: JSON.stringify({ muse_id: "agent_sample0001" }) }] }), base: BASE, source: "musedin-record" }),
    (e) => e.status === 502,
  );
  assert.equal(s.listAgents().length, 0);
});
