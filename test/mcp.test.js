import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp.js";
import { memStore, mockFetch, musedinRoutes, BASE } from "./helpers.js";

const TOOLS = [
  "list_agents",
  "get_agent",
  "add_agent",
  "update_agent",
  "import_from_musedin",
  "log_engagement",
  "move_stage",
  "add_followup",
  "list_followups",
  "complete_followup",
  "pipeline_summary",
];

async function connect(store = memStore(), opts = {}) {
  const server = createMcpServer(store, opts);
  const client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const text = r.content[0].text;
    return r.isError ? { error: text } : JSON.parse(text);
  };
  return { client, call, store };
}

test("tools are listed with plain, self-contained descriptions", async () => {
  const { client } = await connect();
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [...TOOLS].sort());
  for (const t of tools) {
    assert.ok(t.description && t.description.length < 300, t.name);
    for (const other of TOOLS) assert.ok(!t.description.includes(other), `${t.name} names ${other}`);
    assert.doesNotMatch(t.description, /https?:\/\/|README|docs?\b/i, `${t.name} points outside`);
    assert.equal(typeof t.annotations?.readOnlyHint, "boolean", `${t.name} annotations`);
  }
  const reads = tools.filter((t) => t.annotations.readOnlyHint).map((t) => t.name).sort();
  assert.deepEqual(reads, ["get_agent", "list_agents", "list_followups", "pipeline_summary"]);
});

test("a full run through every tool", async () => {
  const { call } = await connect();
  const a = await call("add_agent", { name: "Vela", skills: "python, testing", rate: "5 USDC per task", tags: ["trial"] });
  assert.equal(a.status, "prospect");
  const u = await call("update_agent", { agent: a.id, status: "active", append_note: "good first call" });
  assert.equal(u.status, "active");
  assert.match(u.notes, /good first call/);

  assert.deepEqual((await call("list_agents", { q: "pyth" })).agents.map((x) => x.id), [a.id]);
  assert.deepEqual((await call("list_agents", { status: "paused" })).agents, []);

  const e = await call("log_engagement", { agent: a.id, title: "Write tests", stage: "hired", amount: "5 USDC" });
  assert.equal(e.stage, "hired");
  const d = await call("move_stage", { engagement: e.id, stage: "delivered", evidence: ["https://example.org/pr/2"] });
  assert.equal(d.stage, "delivered");
  await call("move_stage", { engagement: e.id, stage: "paid" });

  const f = await call("add_followup", { agent: a.id, due: "2026-10-20", text: "Offer a second task" });
  assert.deepEqual((await call("list_followups", {})).followups.map((x) => x.id), [f.id]);
  assert.equal((await call("complete_followup", { followup: f.id })).done, true);
  assert.deepEqual((await call("list_followups", {})).followups, []);

  const g = await call("get_agent", { agent: a.id });
  assert.equal(g.engagements[0].stage, "paid");
  assert.equal(g.followups.length, 1);

  const p = await call("pipeline_summary");
  assert.deepEqual(p.stages.paid, { count: 1, amounts: { USDC: 5 } });
  assert.equal(p.agents.active, 1);
});

test("bad calls come back as tool errors, not crashes", async () => {
  const { call } = await connect();
  assert.match((await call("get_agent", { agent: "missing" })).error, /no agent missing \(404\)/);
  assert.match((await call("add_agent", { name: " " })).error, /name is required/);
  assert.match((await call("move_stage", { engagement: "en_x", stage: "paid" })).error, /404/);
  assert.match((await call("add_followup", { agent: "missing", due: "2026-10-01", text: "x" })).error, /404/);
  const r = await call("add_agent", { name: "x", status: "retired" });
  assert.ok(r.error, "enum checked by the schema");
});

test("import_from_musedin uses the importer and its fetch", async () => {
  const { call } = await connect(memStore(), { importOptions: { fetch: mockFetch(musedinRoutes()), base: BASE } });
  const r = await call("import_from_musedin", { ref: "agent_abc123xyz0" });
  assert.equal(r.created, true);
  assert.equal(r.agent.name, "Spore");
  assert.equal(r.agent.engagements.length, 3);
  const again = await call("import_from_musedin", { ref: "agent_abc123xyz0" });
  assert.equal(again.created, false);
  assert.equal((await call("get_agent", { agent: "agent_abc123xyz0" })).name, "Spore");
  assert.match((await call("import_from_musedin", { ref: "https://example.org/u/1" })).error, /cannot read|no importer/);
  assert.match((await call("import_from_musedin", { ref: "muse_nobody0000" })).error, /404/);
});
