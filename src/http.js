// HTTP server: a small REST API and MCP over Streamable HTTP (stateless, JSON answers) on one store.
import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer } from "./mcp.js";
import { RostraError } from "./store.js";
import { importAgent } from "./importers/index.js";
import { VERSION } from "./version.js";

const MAX_BODY = 1024 * 1024;
const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

function send(res, status, body) {
  const s = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(s);
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw new RostraError("body over 1 MB", 413);
    chunks.push(c);
  }
  if (!size) return {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error();
    return v;
  } catch {
    throw new RostraError("body must be a JSON object");
  }
}

function tokenOk(req, token) {
  if (!token) return true;
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || "");
  if (!m) return false;
  const a = Buffer.from(m[1]);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** A browser page on another site must not drive a local server (DNS rebinding, CSRF). */
function originOk(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

/**
 * @param {import("./store.js").Store} store
 * @param {{token?: string, importOptions?: object}} [opts]
 */
export function createHttpHandler(store, opts = {}) {
  const routes = [
    ["GET", /^\/api\/agents$/, (q) => ({ agents: store.listAgents(Object.fromEntries(q)) })],
    ["POST", /^\/api\/agents$/, (q, b) => [201, store.addAgent(b)]],
    ["GET", /^\/api\/agents\/([^/]+)$/, (q, b, id) => store.getAgent(id)],
    ["PATCH", /^\/api\/agents\/([^/]+)$/, (q, b, id) => store.updateAgent(store.resolveAgent(id).id, b)],
    ["POST", /^\/api\/agents\/([^/]+)\/engagements$/, (q, b, id) => [201, store.addEngagement({ ...b, agent_id: id })]],
    ["POST", /^\/api\/agents\/([^/]+)\/followups$/, (q, b, id) => [201, store.addFollowup({ ...b, agent_id: id })]],
    ["GET", /^\/api\/engagements$/, (q) => ({ engagements: store.listEngagements({ agent_id: q.get("agent") || undefined, stage: q.get("stage") || undefined }) })],
    ["GET", /^\/api\/engagements\/([^/]+)$/, (q, b, id) => store.getEngagement(id)],
    ["PATCH", /^\/api\/engagements\/([^/]+)$/, (q, b, id) => store.moveStage(id, b.stage, b)],
    [
      "GET",
      /^\/api\/followups$/,
      (q) => ({ followups: store.listFollowups({ agent_id: q.get("agent") || undefined, due_before: q.get("due_before") || undefined, include_done: q.get("include_done") === "1" }) }),
    ],
    ["POST", /^\/api\/followups\/([^/]+)\/done$/, (q, b, id) => store.completeFollowup(id)],
    ["POST", /^\/api\/import$/, async (q, b) => importAgent(store, b.ref, { ...opts.importOptions, source: b.source })],
    ["GET", /^\/api\/pipeline$/, () => store.pipeline()],
  ];

  return async function handle(req, res) {
    const u = new URL(req.url, "http://local");
    try {
      if (u.pathname === "/health") return send(res, 200, { ok: true, name: "rostra", version: VERSION });
      if (!originOk(req)) throw new RostraError("cross-origin requests are refused", 403);
      if (!tokenOk(req, opts.token)) throw new RostraError("send Authorization: Bearer <token>", 401);

      if (u.pathname === "/mcp") {
        if (req.method !== "POST") throw new RostraError("POST only (stateless server)", 405);
        const body = await readJson(req);
        const server = createMcpServer(store, opts);
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        res.on("close", () => {
          transport.close();
          server.close();
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
        return;
      }

      for (const [method, re, fn] of routes) {
        const m = re.exec(u.pathname);
        if (!m) continue;
        if (req.method !== method && !(req.method === "HEAD" && method === "GET")) continue;
        const body = method === "GET" ? {} : await readJson(req);
        const out = await fn(u.searchParams, body, m[1] && decodeURIComponent(m[1]));
        return Array.isArray(out) ? send(res, out[0], out[1]) : send(res, 200, out);
      }
      throw new RostraError(`no route ${req.method} ${u.pathname}`, 404);
    } catch (e) {
      if (res.headersSent) return res.end();
      if (e instanceof RostraError) return send(res, e.status, { error: e.message });
      return send(res, 500, { error: "internal error" });
    }
  };
}

/**
 * Start the server. Binding beyond loopback needs a token.
 * @param {import("./store.js").Store} store
 * @param {{port?: number, host?: string, token?: string, importOptions?: object}} [opts]
 */
export async function startHttp(store, opts = {}) {
  const host = opts.host || "127.0.0.1";
  if (!LOOPBACK.has(host) && !opts.token) throw new Error("set ROSTRA_TOKEN to serve beyond 127.0.0.1");
  const server = createServer(createHttpHandler(store, opts));
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 8787, host, () => resolve(server));
  });
}
