import { test, after } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startHttp } from "../src/http.js";
import { memStore, mockFetch, musedinRoutes, BASE, loopbackFetch } from "./helpers.js";

const servers = [];
after(() => servers.forEach((s) => s.close()));

async function serve(opts = {}) {
  const store = memStore();
  const server = await startHttp(store, { port: 0, importOptions: { fetch: mockFetch(musedinRoutes()), base: BASE }, ...opts });
  servers.push(server);
  const url = `http://127.0.0.1:${server.address().port}`;
  const req = async (method, path, body, headers = {}) => {
    const r = await loopbackFetch(url + path, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  return { url, req, store };
}

test("REST API: agents, engagements, follow-ups, import, pipeline", async () => {
  const { req } = await serve();
  assert.equal((await req("GET", "/health")).body.name, "rostra");
  const a = await req("POST", "/api/agents", { name: "Vela", skills: ["python"] });
  assert.equal(a.status, 201);
  const id = a.body.id;
  assert.equal((await req("PATCH", `/api/agents/${id}`, { status: "active" })).body.status, "active");
  assert.equal((await req("GET", "/api/agents?status=active")).body.agents.length, 1);
  const e = await req("POST", `/api/agents/${id}/engagements`, { title: "Tests", stage: "hired", amount: "3 USDC" });
  assert.equal(e.status, 201);
  assert.equal((await req("PATCH", `/api/engagements/${e.body.id}`, { stage: "paid" })).body.stage, "paid");
  assert.equal((await req("GET", "/api/engagements?stage=paid")).body.engagements.length, 1);
  const f = await req("POST", `/api/agents/${id}/followups`, { due: "2026-10-20", text: "Next task" });
  assert.equal((await req("GET", "/api/followups")).body.followups.length, 1);
  assert.equal((await req("POST", `/api/followups/${f.body.id}/done`)).body.done, true);
  assert.equal((await req("GET", "/api/followups?include_done=1")).body.followups.length, 1);
  const imp = await req("POST", "/api/import", { ref: "agent_abc123xyz0" });
  assert.equal(imp.status, 200);
  assert.equal(imp.body.agent.name, "Spore");
  const one = await req("GET", "/api/agents/agent_abc123xyz0");
  assert.equal(one.body.engagements.length, 3);
  assert.equal((await req("GET", "/api/pipeline")).body.agents.active, 1);
});

test("REST API errors", async () => {
  const { req, url } = await serve();
  assert.equal((await req("GET", "/api/agents/nope")).status, 404);
  assert.equal((await req("POST", "/api/agents", {})).status, 400);
  assert.equal((await req("GET", "/nowhere")).status, 404);
  assert.equal((await req("DELETE", "/api/agents")).status, 404);
  const bad = await loopbackFetch(url + "/api/agents", { method: "POST", body: "[1,2" });
  assert.equal(bad.status, 400);
  const big = await loopbackFetch(url + "/api/agents", { method: "POST", body: JSON.stringify({ name: "x".repeat(1100000) }) });
  assert.equal(big.status, 413);
  assert.equal((await req("GET", "/api/agents", undefined, { origin: "https://evil.example" })).status, 403);
  assert.equal((await req("GET", "/mcp")).status, 405);
});

test("a token, when set, is required (health stays open)", async () => {
  const { req } = await serve({ token: "s3cret-token" });
  assert.equal((await req("GET", "/health")).status, 200);
  assert.equal((await req("GET", "/api/agents")).status, 401);
  assert.equal((await req("GET", "/api/agents", undefined, { authorization: "Bearer wrong" })).status, 401);
  assert.equal((await req("GET", "/api/agents", undefined, { authorization: "Bearer s3cret-token" })).status, 200);
});

test("serving beyond loopback needs a token", async () => {
  await assert.rejects(startHttp(memStore(), { port: 0, host: "0.0.0.0" }), /ROSTRA_TOKEN/);
});

test("MCP over Streamable HTTP", async () => {
  const { url, store } = await serve({ token: "tok" });
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url + "/mcp"), { fetch: loopbackFetch, requestInit: { headers: { authorization: "Bearer tok" } } }));
  const { tools } = await client.listTools();
  assert.equal(tools.length, 11);
  const r = await client.callTool({ name: "add_agent", arguments: { name: "Over HTTP" } });
  assert.equal(JSON.parse(r.content[0].text).name, "Over HTTP");
  const imp = await client.callTool({ name: "import_from_musedin", arguments: { ref: "agent_abc123xyz0" } });
  assert.equal(JSON.parse(imp.content[0].text).agent.name, "Spore");
  assert.equal(store.listAgents().length, 2, "same store as the REST API");
  await client.close();
});
