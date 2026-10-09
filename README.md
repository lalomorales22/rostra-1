# Rostra

Agent resource management: keep track of the AI agents you work with.

You hire agents for tasks, check what they deliver, pay them, and come back to the ones that did well. Rostra keeps that record in one SQLite file on your machine: who each agent is and where it lives, what you engaged it for and how far each piece of work got (proposed, hired, delivered, accepted, paid), the evidence links, and what you meant to follow up on.

It comes as an MCP server (so your own assistant can read and update the record), a small REST API, a CLI, and a library.

Version 0.1. Open source, MIT.

## Why

People and agents now hire agents from many places: job boards, agent networks, A2A endpoints, a friend's repo. The record of who did what, for how much, with what proof, ends up scattered across chats and dashboards. Rostra puts it in one file you own, with an import that reads an agent's public profile and delivered work so you don't type it in.

## Quickstart

Needs Node 22.13 or newer (Rostra uses the built-in `node:sqlite`).

```sh
git clone https://github.com/molonlav3/rostra.git
cd rostra
npm install
node bin/rostra.js --help
```

Or run it straight from GitHub, no clone:

```sh
npx github:molonlav3/rostra --help
```

A first session:

```sh
rostra add "Vela" --skills python,testing --rate "5 USDC per task"
rostra import agent_a9fesqyakw          # a MusedIn member, by id or profile URL
rostra list
rostra engage agent_a9fesqyakw "Review my parser" --stage hired --amount "4 USDC"
rostra move en_1a2b3c4d5e6f delivered --evidence https://github.com/you/repo/pull/12
rostra follow agent_a9fesqyakw 2026-10-20 "Offer the next task"
rostra pipeline
```

(`rostra` is `node bin/rostra.js` until you run `npm link` or install it globally.)

The database is `~/.rostra/rostra.db` unless you set `ROSTRA_DB` or pass `--db <file>`. Add `--json` to any command for JSON output.

## Data

| Record | Fields |
| --- | --- |
| Agent | id, name, source (platform), source_ref (its id there), profile_url, skills, rate, availability, status (`prospect`, `active`, `paused`, `ended`), tags, notes |
| Engagement | agent, title, stage (`proposed`, `hired`, `delivered`, `accepted`, `paid`), a date per stage reached, amount (as written, e.g. `5 USDC`), evidence links |
| Follow-up | agent, due date, text, done |

Wherever an agent is asked for, you can give its Rostra id (`ag_…`) or its id on its source (for example a MusedIn `muse_…` or `agent_…` id).

Migrations are plain SQL files in `migrations/`, applied in order when the file is opened.

## MCP server

Rostra speaks MCP over stdio (`rostra mcp`) and over Streamable HTTP (`rostra serve`, endpoint `/mcp`).

### Claude Desktop

`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "rostra": {
      "command": "npx",
      "args": ["-y", "github:molonlav3/rostra", "mcp"]
    }
  }
}
```

With a clone, use `"command": "node", "args": ["/path/to/rostra/bin/rostra.js", "mcp"]`. Add `"env": { "ROSTRA_DB": "/path/to/rostra.db" }` to choose the file.

### Claude Code

```sh
claude mcp add rostra -- npx -y github:molonlav3/rostra mcp
```

### Cursor

`.cursor/mcp.json` (or `~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "rostra": { "command": "npx", "args": ["-y", "github:molonlav3/rostra", "mcp"] }
  }
}
```

### VS Code

`.vscode/mcp.json`:

```json
{
  "servers": {
    "rostra": { "type": "stdio", "command": "npx", "args": ["-y", "github:molonlav3/rostra", "mcp"] }
  }
}
```

### Over HTTP

```sh
ROSTRA_TOKEN=$(openssl rand -hex 24) rostra serve --port 8787
```

Then point a client at `http://127.0.0.1:8787/mcp` with the header `Authorization: Bearer <token>`. The server is stateless and answers JSON. It binds to 127.0.0.1 by default; it refuses to bind elsewhere without `ROSTRA_TOKEN`, and refuses browser requests from other origins.

### Tools

| Tool | What it does |
| --- | --- |
| `list_agents` | List or search agents; filter by text, status, tag, skill, source |
| `get_agent` | One agent with its engagements and follow-ups |
| `add_agent` | Add an agent by hand |
| `update_agent` | Change some fields; add or remove tags; append a dated note |
| `import_from_musedin` | Read a MusedIn member's public profile and delivered work and save it |
| `log_engagement` | Record a piece of work at a stage, with amount and evidence |
| `move_stage` | Move an engagement to a stage and date it |
| `add_followup` | A reminder about an agent, due on a date |
| `list_followups` | Open follow-ups, soonest first |
| `complete_followup` | Mark a follow-up done |
| `pipeline_summary` | Agents by status, engagements by stage with amounts, follow-ups overdue and due this week |

Read tools are marked read-only. Nothing deletes data in v0.

## REST API

Same store, served by `rostra serve` (bearer token when `ROSTRA_TOKEN` is set):

```
GET    /health
GET    /api/agents?q=&status=&tag=&skill=&source=&limit=
POST   /api/agents                       {name, skills, rate, status, tags, ...}
GET    /api/agents/:agent
PATCH  /api/agents/:agent                {fields to change, add_tags, remove_tags, append_note}
POST   /api/agents/:agent/engagements    {title, stage, amount, evidence, at}
POST   /api/agents/:agent/followups      {due, text}
GET    /api/engagements?agent=&stage=
GET    /api/engagements/:id
PATCH  /api/engagements/:id              {stage, amount, evidence, at}
GET    /api/followups?agent=&due_before=&include_done=1
POST   /api/followups/:id/done
POST   /api/import                       {ref, source?}
GET    /api/pipeline
POST   /mcp                              MCP (Streamable HTTP)
```

Errors are `{"error": "..."}` with 400, 401, 403, 404, 409, 413 or 502.

## Importers

An importer reads an agent from somewhere else and returns one shape (`src/importers/index.js` documents it). v0 ships one:

- **musedin**: a `muse_…` / `agent_…` id or a `musedin.com/m/<id>` URL. Reads `GET /api/muse/<id>` and `GET /api/muse/<id>/work` (public, no key). Fills name, skills, availability, profile link and headline; each hire becomes an engagement (`hired`, or `delivered` when a delivery is attached) with links to its record and delivery; a payment receipt for the same role moves it to `paid` with the amount; other receipts become paid engagements. Importing again refreshes the same agent, merges skills, moves work forward only, and never touches your status, rate, tags or notes.

Adding a source is one module with `name`, `description`, `match(ref)` and `read(ref, opts)`, listed in `IMPORTERS`.

## As a library

```js
import { openStore, importAgent } from "rostra";

const store = openStore("./agents.db");
const vela = store.addAgent({ name: "Vela", skills: ["python"] });
store.addEngagement({ agent_id: vela.id, title: "Tests", stage: "hired" });
await importAgent(store, "agent_a9fesqyakw");
console.log(store.pipeline());
```

## Tests

```sh
npm test
```

Store, importer (with a stand-in fetch, no network), MCP tools in process, MCP over HTTP and stdio, REST API and CLI.

## Roadmap

- An A2A agent, so other agents can ask Rostra about the agents you work with (with your consent).
- More importers: Moltbook, The Colony, A2A agent cards (`/.well-known/agent-card.json`), GitHub profiles.
- Contracts and invoices: terms per engagement, an invoice from the paid stage, export.
- Checking evidence: read a linked record or PR and note whether it still matches.
- A hosted version with accounts, for teams.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Small PRs, each with a "done:" line.

Incubated at MusedIn: musedin.com/project/arm

## Licence

MIT. See [LICENSE](LICENSE).
