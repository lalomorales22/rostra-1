// The rostra command. run(argv, io) returns an exit code, so tests can call it in process.
import { parseArgs } from "node:util";
import { openStore, defaultDbPath } from "./index.js";
import { RostraError } from "./store.js";
import { importAgent } from "./importers/index.js";
import { VERSION } from "./version.js";

export const HELP = `rostra ${VERSION}: agent resource management

Usage: rostra <command> [options]

  list [--q text] [--status s] [--tag t] [--skill s]   agents, newest change first
  show <agent>                                       one agent, its engagements and follow-ups
  add <name> [--skills a,b] [--rate r] [--status s] [--tags a,b] [--url u] [--notes n]
  update <agent> [--name n] [--skills a,b] [--rate r] [--status s] [--tags a,b] [--url u] [--note line]
  import <muse_id | profile url> [--source name]   read an agent from MusedIn
                                                (default source musedin; use
                                                musedin-record for the signed
                                                /api/muse/<id>/record answer)
  engage <agent> <title> [--stage s] [--amount a] [--evidence url,url]
  move <engagement> <stage> [--amount a] [--evidence url,url]
  follow <agent> <due YYYY-MM-DD> <text>             add a follow-up
  followups [--all] [--due-before date]              open follow-ups
  done <followup>                                    complete a follow-up
  pipeline                                           counts by status and stage
  mcp                                                MCP server on stdio
  serve [--port 8787] [--host 127.0.0.1]             REST API + MCP at /mcp (ROSTRA_TOKEN for a bearer token)

Options: --db <file> (default ROSTRA_DB or ~/.rostra/rostra.db), --json
<agent> is a Rostra id or the agent's id on its source (e.g. a muse_id).
Stages: proposed, hired, delivered, accepted, paid. Statuses: prospect, active, paused, ended.`;

const OPTIONS = {
  db: { type: "string" },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean" },
  q: { type: "string" },
  status: { type: "string" },
  tag: { type: "string" },
  skill: { type: "string" },
  skills: { type: "string" },
  tags: { type: "string" },
  rate: { type: "string" },
  url: { type: "string" },
  notes: { type: "string" },
  note: { type: "string" },
  name: { type: "string" },
  availability: { type: "string" },
  stage: { type: "string" },
  amount: { type: "string" },
  evidence: { type: "string" },
  all: { type: "boolean" },
  "due-before": { type: "string" },
  limit: { type: "string" },
  source: { type: "string" },
  port: { type: "string" },
  host: { type: "string" },
};

const pad = (s, n) => String(s ?? "").slice(0, n).padEnd(n);

function agentLine(a) {
  return `${pad(a.id, 16)} ${pad(a.name, 24)} ${pad(a.status, 9)} ${pad(a.source + (a.source_ref ? ":" + a.source_ref : ""), 28)} ${a.skills.slice(0, 4).join(", ")}`;
}

function showAgent(a) {
  const lines = [
    `${a.name}  (${a.id})`,
    `status ${a.status} · source ${a.source}${a.source_ref ? " " + a.source_ref : ""}`,
  ];
  if (a.profile_url) lines.push(`profile ${a.profile_url}`);
  if (a.skills.length) lines.push(`skills ${a.skills.join(", ")}`);
  if (a.rate) lines.push(`rate ${a.rate}`);
  if (a.availability) lines.push(`availability ${a.availability}`);
  if (a.tags.length) lines.push(`tags ${a.tags.join(", ")}`);
  if (a.notes) lines.push(`notes ${a.notes}`);
  lines.push(`engagements ${a.engagements.length}`);
  for (const e of a.engagements) lines.push(`  ${pad(e.id, 16)} ${pad(e.stage, 9)} ${e.title}${e.amount ? " · " + e.amount : ""}`);
  lines.push(`follow-ups ${a.followups.filter((f) => !f.done).length} open`);
  for (const f of a.followups) lines.push(`  ${pad(f.id, 16)} ${f.due.slice(0, 10)} ${f.done ? "done" : "open"} ${f.text}`);
  return lines.join("\n");
}

/**
 * @param {string[]} argv arguments after the command name
 * @param {{out?: (s: string) => void, err?: (s: string) => void, store?: import("./store.js").Store, importOptions?: object}} [io]
 * @returns {Promise<number>}
 */
export async function run(argv, io = {}) {
  const out = io.out || ((s) => process.stdout.write(s + "\n"));
  const err = io.err || ((s) => process.stderr.write(s + "\n"));
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  } catch (e) {
    err(e.message);
    return 2;
  }
  const { values: o, positionals: p } = parsed;
  const cmd = p.shift();
  if (o.version) {
    out(VERSION);
    return 0;
  }
  if (!cmd || o.help || cmd === "help") {
    out(HELP);
    return cmd || o.help ? 0 : 2;
  }
  const need = (n, usage) => {
    if (p.length < n) throw new RostraError(`usage: rostra ${usage}`);
  };
  const store = io.store || openStore(o.db || defaultDbPath());
  const print = (v, human) => out(o.json || !human ? JSON.stringify(v, null, 2) : human(v));
  try {
    switch (cmd) {
      case "list": {
        const agents = store.listAgents({ q: o.q, status: o.status, tag: o.tag, skill: o.skill, limit: o.limit });
        print(agents, (l) => (l.length ? l.map(agentLine).join("\n") : "no agents"));
        return 0;
      }
      case "show":
        need(1, "show <agent>");
        print(store.getAgent(p[0]), showAgent);
        return 0;
      case "add":
        need(1, "add <name>");
        print(
          store.addAgent({ name: p.join(" "), skills: o.skills, rate: o.rate, status: o.status, tags: o.tags, profile_url: o.url, notes: o.notes, availability: o.availability }),
          (a) => `added ${a.id} ${a.name}`,
        );
        return 0;
      case "update": {
        need(1, "update <agent> [--field value]");
        const patch = {};
        for (const [k, f] of [["name", "name"], ["skills", "skills"], ["rate", "rate"], ["status", "status"], ["tags", "tags"], ["url", "profile_url"], ["notes", "notes"], ["note", "append_note"], ["availability", "availability"]]) {
          if (o[k] !== undefined) patch[f] = o[k];
        }
        print(store.updateAgent(store.resolveAgent(p[0]).id, patch), (a) => `updated ${a.id} ${a.name}`);
        return 0;
      }
      case "import": {
        need(1, "import <muse_id | profile url>");
        const r = await importAgent(store, p[0], { ...(io.importOptions || {}), ...(o.source ? { source: o.source } : {}) });
        print(r, (x) => `${x.created ? "imported" : "refreshed"} ${x.agent.id} ${x.agent.name} from ${x.source}: ${x.agent.skills.length} skills, ${x.engagements_added} engagements added, ${x.engagements_moved} moved`);
        return 0;
      }
      case "engage":
        need(2, "engage <agent> <title>");
        print(store.addEngagement({ agent_id: p[0], title: p.slice(1).join(" "), stage: o.stage, amount: o.amount, evidence: o.evidence }), (e) => `logged ${e.id} ${e.stage} ${e.title}`);
        return 0;
      case "move":
        need(2, "move <engagement> <stage>");
        print(store.moveStage(p[0], p[1], { amount: o.amount, evidence: o.evidence }), (e) => `${e.id} now ${e.stage}`);
        return 0;
      case "follow":
        need(3, "follow <agent> <due> <text>");
        print(store.addFollowup({ agent_id: p[0], due: p[1], text: p.slice(2).join(" ") }), (f) => `follow-up ${f.id} due ${f.due.slice(0, 10)}`);
        return 0;
      case "followups": {
        const list = store.listFollowups({ include_done: o.all, due_before: o["due-before"] });
        print(list, (l) => (l.length ? l.map((f) => `${pad(f.id, 16)} ${f.due.slice(0, 10)} ${f.done ? "done" : "open"} ${pad(f.agent_id, 16)} ${f.text}`).join("\n") : "no follow-ups"));
        return 0;
      }
      case "done":
        need(1, "done <followup>");
        print(store.completeFollowup(p[0]), (f) => `${f.id} done`);
        return 0;
      case "pipeline":
        print(store.pipeline(), (s) =>
          [
            "agents   " + Object.entries(s.agents).map(([k, v]) => `${k} ${v}`).join(" · "),
            "stages   " +
              Object.entries(s.stages)
                .map(([k, v]) => `${k} ${v.count}${Object.keys(v.amounts).length ? " (" + Object.entries(v.amounts).map(([u, n]) => `${n}${u ? " " + u : ""}`).join(", ") + ")" : ""}`)
                .join(" · "),
            `followups overdue ${s.followups.overdue} · due this week ${s.followups.due_this_week}`,
          ].join("\n"),
        );
        return 0;
      case "mcp": {
        const { runStdio } = await import("./stdio.js");
        await runStdio(store);
        return -1; // keeps running
      }
      case "serve": {
        const { startHttp } = await import("./http.js");
        const port = o.port ? Number(o.port) : Number(process.env.PORT) || 8787;
        const host = o.host || process.env.ROSTRA_HOST || "127.0.0.1";
        await startHttp(store, { port, host, token: process.env.ROSTRA_TOKEN || undefined });
        err(`rostra serving http://${host}:${port} (REST /api, MCP /mcp)`);
        return -1;
      }
      default:
        err(`unknown command ${cmd}\n\n${HELP}`);
        return 2;
    }
  } catch (e) {
    err(e instanceof RostraError ? e.message : `error: ${e.message}`);
    return 1;
  }
}
