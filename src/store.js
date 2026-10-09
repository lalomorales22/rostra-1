// The store: agents, engagements and follow-ups in one SQLite file.
// Every read and write of Rostra (MCP tools, REST API, CLI) goes through here.
import { randomBytes } from "node:crypto";

export const AGENT_STATUSES = ["prospect", "active", "paused", "ended"];
export const STAGES = ["proposed", "hired", "delivered", "accepted", "paid"];

/** An error a caller can show as is. status: 400 bad input, 404 not found, 409 conflict. */
export class RostraError extends Error {
  /** @param {string} message @param {number} [status] */
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const now = () => new Date().toISOString();
const newId = (prefix) => prefix + "_" + randomBytes(6).toString("hex");

function text(v, field, { max = 2000, required = false } = {}) {
  if (v === undefined || v === null || v === "") {
    if (required) throw new RostraError(`${field} is required`);
    return null;
  }
  if (typeof v !== "string") throw new RostraError(`${field} must be a string`);
  const s = v.trim();
  if (!s && required) throw new RostraError(`${field} is required`);
  if (s.length > max) throw new RostraError(`${field}: ${max} characters at most`);
  return s || null;
}

/** Accept an array of strings or a comma-separated string. Trimmed, de-duplicated (any case). */
export function list(v, field = "list") {
  if (v === undefined || v === null || v === "") return [];
  const items = Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : null;
  if (!items) throw new RostraError(`${field} must be a list of strings`);
  const out = [];
  const seen = new Set();
  for (const raw of items) {
    if (typeof raw !== "string") throw new RostraError(`${field} must be a list of strings`);
    const s = raw.trim();
    if (!s || seen.has(s.toLowerCase())) continue;
    if (s.length > 500) throw new RostraError(`${field}: each item 500 characters at most`);
    seen.add(s.toLowerCase());
    out.push(s);
  }
  if (out.length > 50) throw new RostraError(`${field}: 50 items at most`);
  return out;
}

function url(v, field) {
  const s = text(v, field, { max: 500 });
  if (s === null) return null;
  let u;
  try {
    u = new URL(s);
  } catch {
    throw new RostraError(`${field} must be a URL`);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new RostraError(`${field} must be an http(s) URL`);
  return u.href;
}

/** ISO date or date-time; returns an ISO string. */
function when(v, field, { required = false } = {}) {
  const s = text(v, field, { max: 40, required });
  if (s === null) return null;
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? s + "T00:00:00Z" : s);
  if (Number.isNaN(d.getTime())) throw new RostraError(`${field} must be a date (YYYY-MM-DD or ISO 8601)`);
  return d.toISOString();
}

function oneOf(v, field, values, fallback) {
  if (v === undefined || v === null || v === "") return fallback;
  if (!values.includes(v)) throw new RostraError(`${field} must be one of: ${values.join(", ")}`);
  return v;
}

const agentOut = (r) =>
  r && {
    id: r.id,
    name: r.name,
    source: r.source,
    source_ref: r.source_ref,
    profile_url: r.profile_url,
    skills: JSON.parse(r.skills),
    rate: r.rate,
    availability: r.availability,
    status: r.status,
    tags: JSON.parse(r.tags),
    notes: r.notes,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };

const engagementOut = (r) =>
  r && {
    id: r.id,
    agent_id: r.agent_id,
    title: r.title,
    stage: r.stage,
    amount: r.amount,
    evidence: JSON.parse(r.evidence),
    source_ref: r.source_ref,
    dates: { proposed: r.proposed_at, hired: r.hired_at, delivered: r.delivered_at, accepted: r.accepted_at, paid: r.paid_at },
    created_at: r.created_at,
    updated_at: r.updated_at,
  };

const followupOut = (r) =>
  r && { id: r.id, agent_id: r.agent_id, due: r.due, text: r.text, done: !!r.done, done_at: r.done_at, created_at: r.created_at };

const AMOUNT = /^\s*([0-9]+(?:\.[0-9]+)?)\s*([A-Za-z$]{1,10})?\s*$/;

export class Store {
  /** @param {import("node:sqlite").DatabaseSync} db */
  constructor(db) {
    this.db = db;
  }

  /** Run fn in one transaction. */
  tx(fn) {
    this.db.exec("BEGIN");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  // ---- agents ----

  addAgent(input = {}) {
    const t = now();
    const a = {
      id: newId("ag"),
      name: text(input.name, "name", { max: 120, required: true }),
      source: text(input.source, "source", { max: 40 }) || "manual",
      source_ref: text(input.source_ref, "source_ref", { max: 200 }),
      profile_url: url(input.profile_url, "profile_url"),
      skills: list(input.skills, "skills"),
      rate: text(input.rate, "rate", { max: 100 }),
      availability: text(input.availability, "availability", { max: 200 }),
      status: oneOf(input.status, "status", AGENT_STATUSES, "prospect"),
      tags: list(input.tags, "tags"),
      notes: text(input.notes, "notes", { max: 10000 }),
    };
    if (a.source_ref && this.findBySource(a.source, a.source_ref)) {
      throw new RostraError(`an agent from ${a.source} with ref ${a.source_ref} exists already`, 409);
    }
    this.db
      .prepare(
        `INSERT INTO agents (id, name, source, source_ref, profile_url, skills, rate, availability, status, tags, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(a.id, a.name, a.source, a.source_ref, a.profile_url, JSON.stringify(a.skills), a.rate, a.availability, a.status, JSON.stringify(a.tags), a.notes, t, t);
    return this.getAgentRow(a.id);
  }

  /** Change only the fields sent. Lists replace the stored list; add_tags / remove_tags edit it; append_note adds a dated line. */
  updateAgent(id, patch = {}) {
    const cur = this.getAgentRow(id);
    if (!cur) throw new RostraError(`no agent ${id}`, 404);
    const next = { ...cur };
    if ("name" in patch) next.name = text(patch.name, "name", { max: 120, required: true });
    if ("profile_url" in patch) next.profile_url = url(patch.profile_url, "profile_url");
    if ("skills" in patch) next.skills = list(patch.skills, "skills");
    if ("rate" in patch) next.rate = text(patch.rate, "rate", { max: 100 });
    if ("availability" in patch) next.availability = text(patch.availability, "availability", { max: 200 });
    if ("status" in patch) next.status = oneOf(patch.status, "status", AGENT_STATUSES, cur.status);
    if ("tags" in patch) next.tags = list(patch.tags, "tags");
    if ("add_tags" in patch) next.tags = list([...next.tags, ...list(patch.add_tags, "add_tags")], "tags");
    if ("remove_tags" in patch) {
      const drop = new Set(list(patch.remove_tags, "remove_tags").map((s) => s.toLowerCase()));
      next.tags = next.tags.filter((s) => !drop.has(s.toLowerCase()));
    }
    if ("notes" in patch) next.notes = text(patch.notes, "notes", { max: 10000 });
    if ("append_note" in patch) {
      const add = text(patch.append_note, "append_note", { max: 2000 });
      if (add) next.notes = (next.notes ? next.notes + "\n" : "") + `${now().slice(0, 10)}: ${add}`;
    }
    this.db
      .prepare(`UPDATE agents SET name = ?, profile_url = ?, skills = ?, rate = ?, availability = ?, status = ?, tags = ?, notes = ?, updated_at = ? WHERE id = ?`)
      .run(next.name, next.profile_url, JSON.stringify(next.skills), next.rate, next.availability, next.status, JSON.stringify(next.tags), next.notes, now(), cur.id);
    return this.getAgentRow(cur.id);
  }

  getAgentRow(id) {
    return agentOut(this.db.prepare("SELECT * FROM agents WHERE id = ?").get(String(id ?? "")));
  }

  findBySource(source, ref) {
    return agentOut(this.db.prepare("SELECT * FROM agents WHERE source = ? AND source_ref = ?").get(source, ref));
  }

  /** Resolve a Rostra id or a source ref (for example a muse_id) to an agent row. */
  resolveAgent(idOrRef) {
    const key = String(idOrRef ?? "").trim();
    const a = this.getAgentRow(key) || agentOut(this.db.prepare("SELECT * FROM agents WHERE source_ref = ? ORDER BY created_at LIMIT 1").get(key));
    if (!a) throw new RostraError(`no agent ${key}`, 404);
    return a;
  }

  /** An agent with its engagements and follow-ups. */
  getAgent(idOrRef) {
    const a = this.resolveAgent(idOrRef);
    return { ...a, engagements: this.listEngagements({ agent_id: a.id }), followups: this.listFollowups({ agent_id: a.id, include_done: true }) };
  }

  /** @param {{q?: string, status?: string, tag?: string, skill?: string, source?: string, limit?: number}} f */
  listAgents(f = {}) {
    const where = [];
    const args = [];
    if (f.status) {
      where.push("status = ?");
      args.push(oneOf(f.status, "status", AGENT_STATUSES));
    }
    if (f.source) {
      where.push("source = ?");
      args.push(String(f.source));
    }
    if (f.tag) {
      where.push("EXISTS (SELECT 1 FROM json_each(agents.tags) WHERE lower(value) = lower(?))");
      args.push(String(f.tag));
    }
    if (f.skill) {
      where.push("EXISTS (SELECT 1 FROM json_each(agents.skills) WHERE lower(value) = lower(?))");
      args.push(String(f.skill));
    }
    if (f.q && String(f.q).trim()) {
      where.push(
        "instr(lower(name || ' ' || skills || ' ' || tags || ' ' || coalesce(notes, '') || ' ' || coalesce(source_ref, '') || ' ' || coalesce(availability, '')), lower(?)) > 0",
      );
      args.push(String(f.q).trim());
    }
    const limit = Math.min(Math.max(Math.trunc(Number(f.limit)) || 50, 1), 500);
    return this.db
      .prepare(`SELECT * FROM agents ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY updated_at DESC, id LIMIT ${limit}`)
      .all(...args)
      .map(agentOut);
  }

  // ---- engagements ----

  addEngagement(input = {}) {
    const agent = this.resolveAgent(input.agent_id);
    const stage = oneOf(input.stage, "stage", STAGES, "proposed");
    const t = now();
    const id = newId("en");
    const dates = Object.fromEntries(STAGES.map((s) => [s, null]));
    dates[stage] = when(input.at, "at") || t;
    this.db
      .prepare(
        `INSERT INTO engagements (id, agent_id, title, stage, amount, evidence, source_ref, proposed_at, hired_at, delivered_at, accepted_at, paid_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        agent.id,
        text(input.title, "title", { max: 200, required: true }),
        stage,
        text(input.amount, "amount", { max: 60 }),
        JSON.stringify(list(input.evidence, "evidence").map((e) => url(e, "evidence"))),
        text(input.source_ref, "source_ref", { max: 200 }),
        dates.proposed,
        dates.hired,
        dates.delivered,
        dates.accepted,
        dates.paid,
        t,
        t,
      );
    this.db.prepare("UPDATE agents SET updated_at = ? WHERE id = ?").run(t, agent.id);
    return this.getEngagement(id);
  }

  getEngagement(id) {
    const e = engagementOut(this.db.prepare("SELECT * FROM engagements WHERE id = ?").get(String(id ?? "")));
    if (!e) throw new RostraError(`no engagement ${id}`, 404);
    return e;
  }

  /** Move to any stage (forward or back) and date it; optionally set the amount and add evidence links. */
  moveStage(id, stage, opts = {}) {
    const e = this.getEngagement(id);
    if (!stage) throw new RostraError("stage is required");
    const to = oneOf(stage, "stage", STAGES);
    const at = when(opts.at, "at") || now();
    const evidence = list([...e.evidence, ...list(opts.evidence, "evidence").map((x) => url(x, "evidence"))], "evidence");
    const amount = opts.amount !== undefined ? text(opts.amount, "amount", { max: 60 }) : e.amount;
    const t = now();
    this.db.prepare(`UPDATE engagements SET stage = ?, ${to}_at = ?, amount = ?, evidence = ?, updated_at = ? WHERE id = ?`).run(to, at, amount, JSON.stringify(evidence), t, e.id);
    this.db.prepare("UPDATE agents SET updated_at = ? WHERE id = ?").run(t, e.agent_id);
    return this.getEngagement(e.id);
  }

  listEngagements(f = {}) {
    const where = [];
    const args = [];
    if (f.agent_id) {
      where.push("agent_id = ?");
      args.push(this.resolveAgent(f.agent_id).id);
    }
    if (f.stage) {
      where.push("stage = ?");
      args.push(oneOf(f.stage, "stage", STAGES));
    }
    return this.db
      .prepare(`SELECT * FROM engagements ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC, id`)
      .all(...args)
      .map(engagementOut);
  }

  // ---- follow-ups ----

  addFollowup(input = {}) {
    const agent = this.resolveAgent(input.agent_id);
    const id = newId("fu");
    this.db
      .prepare("INSERT INTO followups (id, agent_id, due, text, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, agent.id, when(input.due, "due", { required: true }), text(input.text, "text", { max: 1000, required: true }), now());
    return followupOut(this.db.prepare("SELECT * FROM followups WHERE id = ?").get(id));
  }

  /** Open follow-ups, soonest due first. include_done adds done ones; due_before keeps those due by then. */
  listFollowups(f = {}) {
    const where = [];
    const args = [];
    if (f.agent_id) {
      where.push("agent_id = ?");
      args.push(this.resolveAgent(f.agent_id).id);
    }
    if (!f.include_done) where.push("done = 0");
    if (f.due_before) {
      where.push("due <= ?");
      args.push(when(f.due_before, "due_before"));
    }
    return this.db
      .prepare(`SELECT * FROM followups ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY done, due, id`)
      .all(...args)
      .map(followupOut);
  }

  completeFollowup(id) {
    const r = this.db.prepare("SELECT * FROM followups WHERE id = ?").get(String(id ?? ""));
    if (!r) throw new RostraError(`no follow-up ${id}`, 404);
    if (!r.done) this.db.prepare("UPDATE followups SET done = 1, done_at = ? WHERE id = ?").run(now(), r.id);
    return followupOut(this.db.prepare("SELECT * FROM followups WHERE id = ?").get(r.id));
  }

  // ---- summary ----

  /**
   * Agents by status, engagements by stage (amounts like "5 USDC" summed per unit),
   * follow-ups overdue and due in the next 7 days.
   */
  pipeline(at = new Date()) {
    const agents = Object.fromEntries(AGENT_STATUSES.map((s) => [s, 0]));
    for (const r of this.db.prepare("SELECT status, COUNT(*) n FROM agents GROUP BY status").all()) agents[r.status] = r.n;
    const stages = Object.fromEntries(STAGES.map((s) => [s, { count: 0, amounts: {} }]));
    for (const r of this.db.prepare("SELECT stage, amount FROM engagements").all()) {
      const s = stages[r.stage];
      s.count++;
      const m = AMOUNT.exec(r.amount || "");
      if (m) {
        const unit = m[2] || "";
        s.amounts[unit] = Math.round(((s.amounts[unit] || 0) + Number(m[1])) * 1e6) / 1e6;
      }
    }
    const nowIso = at.toISOString();
    const week = new Date(at.getTime() + 7 * 864e5).toISOString();
    const overdue = this.db.prepare("SELECT COUNT(*) n FROM followups WHERE done = 0 AND due < ?").get(nowIso).n;
    const dueWeek = this.db.prepare("SELECT COUNT(*) n FROM followups WHERE done = 0 AND due >= ? AND due <= ?").get(nowIso, week).n;
    return { agents, stages, followups: { overdue, due_this_week: dueWeek } };
  }

  // ---- imports ----

  /**
   * Save what an importer read. The agent matched by (source, source_ref) is updated
   * (name, profile_url, availability; skills merged), else created. Status, rate, tags
   * and notes stay yours. Engagements are matched by source_ref and only move forward.
   * @param {{agent: object, engagements?: object[]}} data
   */
  saveImport(data) {
    return this.tx(() => {
      const src = data.agent;
      let agent = this.findBySource(src.source, src.source_ref);
      let created = false;
      if (agent) {
        agent = this.updateAgent(agent.id, {
          name: src.name,
          profile_url: src.profile_url ?? agent.profile_url,
          skills: [...agent.skills, ...(src.skills || [])],
          availability: src.availability ?? agent.availability,
        });
      } else {
        agent = this.addAgent(src);
        created = true;
      }
      let added = 0;
      let moved = 0;
      for (const e of data.engagements || []) {
        const cur = e.source_ref && engagementOut(this.db.prepare("SELECT * FROM engagements WHERE agent_id = ? AND source_ref = ?").get(agent.id, e.source_ref));
        if (!cur) {
          const made = this.addEngagement({ ...e, agent_id: agent.id });
          for (const [stage, at] of Object.entries(e.dates || {})) {
            if (at && stage !== made.stage && STAGES.includes(stage)) {
              this.db.prepare(`UPDATE engagements SET ${stage}_at = ? WHERE id = ?`).run(when(at, "date"), made.id);
            }
          }
          added++;
        } else if (STAGES.indexOf(e.stage) > STAGES.indexOf(cur.stage)) {
          this.moveStage(cur.id, e.stage, { at: e.at, evidence: e.evidence });
          moved++;
        }
      }
      return { created, agent: this.getAgent(agent.id), engagements_added: added, engagements_moved: moved };
    });
  }
}
