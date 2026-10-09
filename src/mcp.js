// MCP server: Rostra's tools over one store. Used by the stdio entry and by the HTTP server.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { AGENT_STATUSES, STAGES, RostraError } from "./store.js";
import { importAgent } from "./importers/index.js";
import { VERSION } from "./version.js";

const stringList = z.union([z.array(z.string()), z.string()]);
const status = z.enum(AGENT_STATUSES);
const stage = z.enum(STAGES);

const agentFields = {
  profile_url: z.string().optional().describe("Link to the agent's profile page"),
  skills: stringList.optional().describe("Skills, as a list or comma-separated"),
  rate: z.string().optional().describe('What the agent charges, as written, e.g. "5 USDC per task"'),
  availability: z.string().optional().describe('Free text, e.g. "weekdays" or "open to work"'),
  status: status.optional().describe("prospect, active, paused or ended"),
  tags: stringList.optional().describe("Your own labels"),
  notes: z.string().optional().describe("Free-form notes"),
};

const json = (v) => ({ content: [{ type: "text", text: JSON.stringify(v, null, 2) }] });
const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

function wrap(fn) {
  return async (args) => {
    try {
      return json(await fn(args ?? {}));
    } catch (e) {
      if (e instanceof RostraError) return { isError: true, content: [{ type: "text", text: `${e.message} (${e.status})` }] };
      return { isError: true, content: [{ type: "text", text: `error: ${e.message}` }] };
    }
  };
}

export const INSTRUCTIONS =
  "Rostra keeps a record of the AI agents you work with: agents, engagements from proposal to payment, and follow-ups. Agents are named by their Rostra id or by the id they have on their source (for example a MusedIn muse_id).";

/**
 * @param {import("./store.js").Store} store
 * @param {{importOptions?: {fetch?: typeof fetch, base?: string}}} [opts]
 */
export function createMcpServer(store, opts = {}) {
  const server = new McpServer({ name: "rostra", version: VERSION }, { instructions: INSTRUCTIONS });
  const t = (name, config, fn) => server.registerTool(name, config, wrap(fn));

  t(
    "list_agents",
    {
      title: "List agents",
      description: "List or search the agents you keep, newest change first. Filter by text, status, tag, skill or source.",
      inputSchema: {
        q: z.string().optional().describe("Text to find in name, skills, tags, notes or source id"),
        status: status.optional(),
        tag: z.string().optional(),
        skill: z.string().optional(),
        source: z.string().optional().describe('Where the agent came from, e.g. "musedin" or "manual"'),
        limit: z.number().int().min(1).max(500).optional().describe("Default 50"),
      },
      annotations: READ,
    },
    (a) => ({ agents: store.listAgents(a) }),
  );

  t(
    "get_agent",
    {
      title: "Get an agent",
      description: "One agent with its engagements and follow-ups.",
      inputSchema: { agent: z.string().describe("Rostra id, or the agent's id on its source") },
      annotations: READ,
    },
    (a) => store.getAgent(a.agent),
  );

  t(
    "add_agent",
    {
      title: "Add an agent",
      description: "Add an agent by hand. Status starts as prospect unless given.",
      inputSchema: {
        name: z.string().describe("The agent's name"),
        source: z.string().optional().describe('Platform the agent is on; default "manual"'),
        source_ref: z.string().optional().describe("The agent's id on that platform"),
        ...agentFields,
      },
      annotations: WRITE,
    },
    (a) => store.addAgent(a),
  );

  t(
    "update_agent",
    {
      title: "Update an agent",
      description: "Change the fields you send and leave the rest. Lists replace the stored list; add_tags, remove_tags and append_note edit in place.",
      inputSchema: {
        agent: z.string().describe("Rostra id, or the agent's id on its source"),
        name: z.string().optional(),
        ...agentFields,
        add_tags: stringList.optional(),
        remove_tags: stringList.optional(),
        append_note: z.string().optional().describe("A line added to the notes with today's date"),
      },
      annotations: { ...WRITE, idempotentHint: true },
    },
    ({ agent, ...patch }) => store.updateAgent(store.resolveAgent(agent).id, patch),
  );

  t(
    "import_from_musedin",
    {
      title: "Import from MusedIn",
      description:
        "Read a MusedIn member's public profile and delivered work, and save it: name, skills, profile link, hires and payments as engagements with links to their records. Running it again refreshes the same agent.",
      inputSchema: { ref: z.string().describe("A muse_ or agent_ id, or a musedin.com profile URL") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    (a) => importAgent(store, a.ref, { ...opts.importOptions, source: "musedin" }),
  );

  t(
    "log_engagement",
    {
      title: "Log an engagement",
      description: "Record a piece of work with an agent: a title, its stage (proposed, hired, delivered, accepted, paid), an amount and evidence links.",
      inputSchema: {
        agent: z.string().describe("Rostra id, or the agent's id on its source"),
        title: z.string(),
        stage: stage.optional().describe("Default proposed"),
        amount: z.string().optional().describe('As written, e.g. "5 USDC"'),
        evidence: stringList.optional().describe("Links that show the work or the payment"),
        at: z.string().optional().describe("When the stage was reached (YYYY-MM-DD or ISO 8601); default now"),
      },
      annotations: WRITE,
    },
    ({ agent, ...rest }) => store.addEngagement({ ...rest, agent_id: agent }),
  );

  t(
    "move_stage",
    {
      title: "Move an engagement",
      description: "Set an engagement's stage and date it. Optionally set the amount and add evidence links.",
      inputSchema: {
        engagement: z.string().describe("Engagement id"),
        stage,
        amount: z.string().optional(),
        evidence: stringList.optional(),
        at: z.string().optional().describe("YYYY-MM-DD or ISO 8601; default now"),
      },
      annotations: { ...WRITE, idempotentHint: true },
    },
    ({ engagement, stage: s, ...rest }) => store.moveStage(engagement, s, rest),
  );

  t(
    "add_followup",
    {
      title: "Add a follow-up",
      description: "Remind yourself to do something about an agent by a date.",
      inputSchema: {
        agent: z.string().describe("Rostra id, or the agent's id on its source"),
        due: z.string().describe("YYYY-MM-DD or ISO 8601"),
        text: z.string(),
      },
      annotations: WRITE,
    },
    ({ agent, ...rest }) => store.addFollowup({ ...rest, agent_id: agent }),
  );

  t(
    "list_followups",
    {
      title: "List follow-ups",
      description: "Open follow-ups, soonest due first. Filter by agent or due date; include_done adds finished ones.",
      inputSchema: {
        agent: z.string().optional(),
        due_before: z.string().optional().describe("YYYY-MM-DD or ISO 8601"),
        include_done: z.boolean().optional(),
      },
      annotations: READ,
    },
    ({ agent, ...rest }) => ({ followups: store.listFollowups({ ...rest, agent_id: agent }) }),
  );

  t(
    "complete_followup",
    {
      title: "Complete a follow-up",
      description: "Mark a follow-up done.",
      inputSchema: { followup: z.string().describe("Follow-up id") },
      annotations: { ...WRITE, idempotentHint: true },
    },
    (a) => store.completeFollowup(a.followup),
  );

  t(
    "pipeline_summary",
    {
      title: "Pipeline summary",
      description: "Counts of agents by status and engagements by stage, amounts per stage, and follow-ups overdue or due in the next 7 days.",
      inputSchema: {},
      annotations: READ,
    },
    () => store.pipeline(),
  );

  return server;
}
