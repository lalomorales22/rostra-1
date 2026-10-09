import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, migrate } from "../src/db.js";
import { Store, RostraError } from "../src/store.js";
import { memStore } from "./helpers.js";

test("migrations apply once and the file reopens", () => {
  const dir = mkdtempSync(join(tmpdir(), "rostra-"));
  try {
    const file = join(dir, "sub", "r.db");
    const db = openDb(file);
    assert.deepEqual(migrate(db), []);
    new Store(db).addAgent({ name: "Kept" });
    db.close();
    const again = new Store(openDb(file));
    assert.equal(again.listAgents()[0].name, "Kept");
    again.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("add, get, list and filter agents", () => {
  const s = memStore();
  const a = s.addAgent({ name: "  Vela ", skills: "python, Python, testing", tags: ["fast"], rate: "5 USDC per task", profile_url: "https://example.org/vela" });
  assert.equal(a.name, "Vela");
  assert.deepEqual(a.skills, ["python", "testing"]);
  assert.equal(a.status, "prospect");
  assert.equal(a.source, "manual");
  s.addAgent({ name: "Tarn", skills: ["writing"], status: "active", tags: ["slow"], source: "colony", source_ref: "tarn-1" });

  assert.equal(s.listAgents().length, 2);
  assert.deepEqual(s.listAgents({ status: "active" }).map((x) => x.name), ["Tarn"]);
  assert.deepEqual(s.listAgents({ skill: "PYTHON" }).map((x) => x.name), ["Vela"]);
  assert.deepEqual(s.listAgents({ tag: "slow" }).map((x) => x.name), ["Tarn"]);
  assert.deepEqual(s.listAgents({ q: "writ" }).map((x) => x.name), ["Tarn"]);
  assert.deepEqual(s.listAgents({ source: "colony" }).map((x) => x.name), ["Tarn"]);
  assert.equal(s.listAgents({ limit: 1 }).length, 1);
  assert.equal(s.getAgent("tarn-1").name, "Tarn", "found by source ref");
  assert.equal(s.getAgent(a.id).engagements.length, 0);
});

test("bad input is a RostraError with a status", () => {
  const s = memStore();
  const bad = (fn, status, re) =>
    assert.throws(fn, (e) => e instanceof RostraError && e.status === status && re.test(e.message));
  bad(() => s.addAgent({}), 400, /name is required/);
  bad(() => s.addAgent({ name: "x", status: "hired" }), 400, /status must be one of/);
  bad(() => s.addAgent({ name: "x", profile_url: "javascript:alert(1)" }), 400, /http/);
  bad(() => s.addAgent({ name: "x", skills: 5 }), 400, /list of strings/);
  bad(() => s.getAgent("nope"), 404, /no agent/);
  s.addAgent({ name: "A", source: "musedin", source_ref: "muse_aaaaaaaa" });
  bad(() => s.addAgent({ name: "B", source: "musedin", source_ref: "muse_aaaaaaaa" }), 409, /exists already/);
  const a = s.addAgent({ name: "C" });
  bad(() => s.addFollowup({ agent_id: a.id, due: "soon", text: "x" }), 400, /date/);
  bad(() => s.addEngagement({ agent_id: a.id, title: "t", stage: "done" }), 400, /stage must be one of/);
});

test("update changes only what is sent", () => {
  const s = memStore();
  const a = s.addAgent({ name: "Vela", skills: ["a"], tags: ["x", "y"], rate: "1" });
  const u = s.updateAgent(a.id, { status: "active", add_tags: ["z", "X"], remove_tags: "y", append_note: "first call went well" });
  assert.equal(u.status, "active");
  assert.deepEqual(u.tags, ["x", "z"]);
  assert.deepEqual(u.skills, ["a"]);
  assert.equal(u.rate, "1");
  assert.match(u.notes, /^\d{4}-\d{2}-\d{2}: first call went well$/);
  const v = s.updateAgent(a.id, { rate: "", append_note: "second" });
  assert.equal(v.rate, null);
  assert.equal(v.notes.split("\n").length, 2);
});

test("engagements move through stages and keep each date", () => {
  const s = memStore();
  const a = s.addAgent({ name: "Vela" });
  const e = s.addEngagement({ agent_id: a.id, title: "Write a client", amount: "10 USDC", at: "2026-10-01" });
  assert.equal(e.stage, "proposed");
  assert.equal(e.dates.proposed, "2026-10-01T00:00:00.000Z");
  const h = s.moveStage(e.id, "hired", { at: "2026-10-02" });
  const d = s.moveStage(h.id, "delivered", { evidence: ["https://example.org/pr/1"] });
  assert.equal(d.stage, "delivered");
  assert.equal(d.dates.hired, "2026-10-02T00:00:00.000Z");
  assert.ok(d.dates.delivered);
  assert.deepEqual(d.evidence, ["https://example.org/pr/1"]);
  const p = s.moveStage(d.id, "paid", { amount: "12 USDC", evidence: "https://example.org/pr/1, https://example.org/tx/9" });
  assert.equal(p.amount, "12 USDC");
  assert.equal(p.evidence.length, 2, "evidence de-duplicated");
  assert.throws(() => s.moveStage(p.id, "nowhere"), /stage must be one of/);
  assert.throws(() => s.moveStage("en_missing", "paid"), (e) => e.status === 404);
  assert.deepEqual(s.listEngagements({ stage: "paid" }).map((x) => x.id), [p.id]);
  assert.equal(s.getAgent(a.id).engagements.length, 1);
});

test("follow-ups: soonest first, complete once", () => {
  const s = memStore();
  const a = s.addAgent({ name: "Vela" });
  const late = s.addFollowup({ agent_id: a.id, due: "2026-12-01", text: "Ask about rates" });
  const soon = s.addFollowup({ agent_id: a.id, due: "2026-10-10", text: "Check the delivery" });
  assert.deepEqual(s.listFollowups().map((f) => f.id), [soon.id, late.id]);
  assert.deepEqual(s.listFollowups({ due_before: "2026-11-01" }).map((f) => f.id), [soon.id]);
  const done = s.completeFollowup(soon.id);
  assert.equal(done.done, true);
  assert.equal(s.completeFollowup(soon.id).done_at, done.done_at, "completing again changes nothing");
  assert.deepEqual(s.listFollowups().map((f) => f.id), [late.id]);
  assert.equal(s.listFollowups({ include_done: true }).length, 2);
});

test("pipeline counts and sums per unit", () => {
  const s = memStore();
  const a = s.addAgent({ name: "A", status: "active" });
  s.addAgent({ name: "B" });
  s.addEngagement({ agent_id: a.id, title: "1", stage: "paid", amount: "5 USDC" });
  s.addEngagement({ agent_id: a.id, title: "2", stage: "paid", amount: "2.5 USDC" });
  s.addEngagement({ agent_id: a.id, title: "3", stage: "paid", amount: "100 sats" });
  s.addEngagement({ agent_id: a.id, title: "4", stage: "hired", amount: "a coffee" });
  s.addFollowup({ agent_id: a.id, due: "2026-10-01", text: "overdue" });
  s.addFollowup({ agent_id: a.id, due: "2026-10-12", text: "this week" });
  s.addFollowup({ agent_id: a.id, due: "2026-11-30", text: "later" });
  const p = s.pipeline(new Date("2026-10-09T12:00:00Z"));
  assert.deepEqual(p.agents, { prospect: 1, active: 1, paused: 0, ended: 0 });
  assert.deepEqual(p.stages.paid, { count: 3, amounts: { USDC: 7.5, sats: 100 } });
  assert.deepEqual(p.stages.hired, { count: 1, amounts: {} });
  assert.deepEqual(p.followups, { overdue: 1, due_this_week: 1 });
});

test("an import updates the same agent and keeps your fields", () => {
  const s = memStore();
  const data = {
    agent: { name: "Spore", source: "musedin", source_ref: "agent_x1y2z3w4", skills: ["research"], profile_url: "https://example.org/m/1" },
    engagements: [{ title: "Hire", stage: "hired", source_ref: "musedin:hire:1", at: "2026-10-01" }],
  };
  const first = s.saveImport(data);
  assert.equal(first.created, true);
  s.updateAgent(first.agent.id, { status: "active", tags: ["mine"], skills: ["research", "my own skill"] });
  const second = s.saveImport({
    agent: { ...data.agent, skills: ["research", "writing"] },
    engagements: [{ ...data.engagements[0], stage: "delivered", at: "2026-10-03", evidence: ["https://example.org/p/1"] }],
  });
  assert.equal(second.created, false);
  assert.equal(second.agent.id, first.agent.id);
  assert.equal(second.agent.status, "active");
  assert.deepEqual(second.agent.tags, ["mine"]);
  assert.deepEqual(second.agent.skills, ["research", "my own skill", "writing"]);
  assert.equal(second.engagements_moved, 1);
  assert.equal(second.agent.engagements[0].stage, "delivered");
  const third = s.saveImport({ agent: data.agent, engagements: data.engagements });
  assert.equal(third.engagements_moved, 0, "never moves back");
  assert.equal(third.agent.engagements[0].stage, "delivered");
});
