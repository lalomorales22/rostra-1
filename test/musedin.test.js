import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRef } from "../src/importers/musedin.js";
import { importAgent, importerFor } from "../src/importers/index.js";
import { RostraError } from "../src/store.js";
import { memStore, mockFetch, musedinRoutes, BASE, PROFILE, WORK } from "./helpers.js";

test("parseRef takes ids and MusedIn profile URLs only", () => {
  assert.equal(parseRef("muse_bxi6xnldmo"), "muse_bxi6xnldmo");
  assert.equal(parseRef(" agent_a9fesqyakw "), "agent_a9fesqyakw");
  assert.equal(parseRef("https://musedin.com/m/agent_a9fesqyakw"), "agent_a9fesqyakw");
  assert.equal(parseRef("https://www.musedin.com/m/muse_bxi6xnldmo/work"), "muse_bxi6xnldmo");
  assert.equal(parseRef("https://musedin.pages.dev/verify/muse_bxi6xnldmo"), "muse_bxi6xnldmo");
  assert.equal(parseRef("https://evil.example/m/muse_bxi6xnldmo"), null);
  assert.equal(parseRef("muse_../../admin"), null);
  assert.equal(parseRef("Muse_ABC123"), null);
  assert.equal(parseRef(""), null);
  assert.throws(() => importerFor("https://example.org/someone"), (e) => e instanceof RostraError && /no importer/.test(e.message));
});

test("import reads profile and work, maps hires and receipts", async () => {
  const s = memStore();
  const calls = [];
  const r = await importAgent(s, "https://musedin.com/m/agent_abc123xyz0", { fetch: mockFetch(musedinRoutes(), calls), base: BASE });
  assert.deepEqual(calls.map((c) => c.url), [`${BASE}/api/muse/agent_abc123xyz0`, `${BASE}/api/muse/agent_abc123xyz0/work`]);
  assert.equal(r.source, "musedin");
  assert.equal(r.created, true);
  const a = r.agent;
  assert.equal(a.name, "Spore");
  assert.equal(a.source_ref, "agent_abc123xyz0");
  assert.equal(a.profile_url, `${BASE}/m/agent_abc123xyz0`);
  assert.deepEqual(a.skills, ["research", "verification", "writing"]);
  assert.equal(a.availability, "open to work");
  assert.equal(a.notes, "Checks claims and writes plainly.");
  assert.equal(r.engagements_added, 3, "two hires (declined left out) and one receipt with no hire");

  const byRef = Object.fromEntries(a.engagements.map((e) => [e.source_ref, e]));
  const paid = byRef["musedin:hire:101"];
  assert.equal(paid.stage, "paid", "the receipt naming the role pays the hire");
  assert.equal(paid.amount, "4.00 USD");
  assert.equal(paid.dates.hired, new Date(Date.UTC(2026, 9, 1)).toISOString());
  assert.equal(paid.dates.delivered, new Date(Date.UTC(2026, 9, 2)).toISOString());
  assert.equal(paid.dates.paid, new Date(Date.UTC(2026, 9, 4)).toISOString());
  assert.deepEqual(paid.evidence, [`${BASE}/api/record/hire/101`, `${BASE}/p/555`, "https://basescan.org/tx/0xabc"]);
  assert.equal(byRef["musedin:hire:102"].stage, "hired");
  assert.equal(byRef["musedin:receipt:901"].stage, "paid");
  assert.equal(byRef["musedin:receipt:901"].amount, "1.50 USD");
  assert.equal(byRef["musedin:hire:103"], undefined);
});

test("importing again refreshes the same agent and moves work forward", async () => {
  const s = memStore();
  const fetch1 = mockFetch(musedinRoutes());
  const first = await importAgent(s, "agent_abc123xyz0", { fetch: fetch1, base: BASE });
  s.updateAgent(first.agent.id, { status: "active", notes: "my notes" });
  const work2 = structuredClone(WORK);
  work2.items[1].delivery = { post: null, url: "https://example.org/translation" };
  work2.items[1].at = Date.UTC(2026, 9, 5);
  const profile2 = structuredClone(PROFILE);
  profile2.muse.skills.push("translation");
  const second = await importAgent(s, "agent_abc123xyz0", { fetch: mockFetch(musedinRoutes(undefined, profile2, work2)), base: BASE });
  assert.equal(second.created, false);
  assert.equal(second.agent.id, first.agent.id);
  assert.equal(second.agent.status, "active");
  assert.equal(second.agent.notes, "my notes");
  assert.ok(second.agent.skills.includes("translation"));
  assert.equal(second.engagements_added, 0);
  assert.equal(second.engagements_moved, 1);
  const moved = second.agent.engagements.find((e) => e.source_ref === "musedin:hire:102");
  assert.equal(moved.stage, "delivered");
  assert.ok(moved.evidence.includes("https://example.org/translation"));
  assert.equal(s.listAgents().length, 1);
});

test("MusedIn errors become RostraErrors and write nothing", async () => {
  const s = memStore();
  await assert.rejects(importAgent(s, "muse_nobody0000", { fetch: mockFetch({}), base: BASE }), (e) => e.status === 404 && /no such muse/.test(e.message));
  await assert.rejects(
    importAgent(s, "agent_abc123xyz0", { fetch: mockFetch({ "/api/muse/agent_abc123xyz0": [500, "<html>oops</html>"] }), base: BASE }),
    (e) => e.status === 502 && /500/.test(e.message),
  );
  await assert.rejects(
    importAgent(s, "agent_abc123xyz0", {
      fetch: mockFetch({ "/api/muse/agent_abc123xyz0": [200, PROFILE], "/api/muse/agent_abc123xyz0/work": [200, "not json"] }),
      base: BASE,
    }),
    (e) => e.status === 502,
  );
  const hang = (url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
  await assert.rejects(importAgent(s, "agent_abc123xyz0", { fetch: hang, base: BASE, timeoutMs: 20 }), /timed out/);
  await assert.rejects(importAgent(s, "not an id", { fetch: mockFetch({}), base: BASE }), (e) => e.status === 400);
  assert.equal(s.listAgents().length, 0);
});

test("odd profile data is cleaned", async () => {
  const s = memStore();
  const profile = { ok: true, muse: { name: "", skills: ["ok", 5, null, "ok"], open_to_work: false } };
  const work = { ok: true, items: [{ kind: "hire", id: 1, title: "x".repeat(400), hired_at: "yesterday", status: "hired", delivery: null }, { kind: "something-else" }] };
  const r = await importAgent(s, "muse_odd0000aa", { fetch: mockFetch(musedinRoutes("muse_odd0000aa", profile, work)), base: BASE });
  assert.equal(r.agent.name, "muse_odd0000aa");
  assert.deepEqual(r.agent.skills, ["ok"]);
  assert.equal(r.agent.availability, null);
  assert.equal(r.agent.engagements.length, 1);
  assert.equal(r.agent.engagements[0].title.length, 200);
});
