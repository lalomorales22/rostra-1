import { openDb } from "../src/db.js";
import { Store } from "../src/store.js";

export const memStore = () => new Store(openDb(":memory:"));

export const BASE = "https://musedin.test";

export const PROFILE = {
  ok: true,
  muse: {
    muse_id: "agent_abc123xyz0",
    name: "Spore",
    headline: "Checks claims and writes plainly.",
    open_to_work: true,
    skills: ["research", "verification", "writing"],
  },
};

export const WORK = {
  ok: true,
  items: [
    { kind: "hire", id: 101, role: "code-review", title: "Review a parser", hired_at: Date.UTC(2026, 9, 1), status: "hired", delivery: { post: 555, url: null }, evidence: "/api/record/hire/101", at: Date.UTC(2026, 9, 2) },
    { kind: "hire", id: 102, role: "translate", title: "Translate a page", hired_at: Date.UTC(2026, 9, 3), status: "hired", delivery: null, evidence: "/api/record/hire/102", at: Date.UTC(2026, 9, 3) },
    { kind: "hire", id: 103, role: "other", title: "Declined one", hired_at: Date.UTC(2026, 9, 3), status: "declined", delivery: null, evidence: "/api/record/hire/103", at: Date.UTC(2026, 9, 3) },
    { kind: "receipt", id: 900, role: "code-review", title: "Review a parser", amount_usd: "4.00", url: "https://basescan.org/tx/0xabc", at: Date.UTC(2026, 9, 4) },
    { kind: "receipt", id: 901, role: null, title: "A musemarket gig", amount_usd: "1.50", url: null, at: Date.UTC(2026, 8, 20) },
  ],
  counts: { hires: 3, delivered: 1, receipts: 2 },
};

/** A fetch stand-in serving MusedIn's two reads from a table of path -> [status, body]. */
export function mockFetch(routes, calls = []) {
  return async (url, init) => {
    calls.push({ url: String(url), init });
    const path = new URL(url).pathname;
    const hit = routes[path];
    if (!hit) return new Response(JSON.stringify({ ok: false, error: "no such muse" }), { status: 404, headers: { "content-type": "application/json" } });
    const [status, body] = hit;
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
}

export const musedinRoutes = (id = "agent_abc123xyz0", profile = PROFILE, work = WORK) => ({
  [`/api/muse/${id}`]: [200, profile],
  [`/api/muse/${id}/work`]: [200, work],
});

/**
 * fetch that retries a connection that never opened (some Windows hosts drop a few
 * loopback connects with ETIMEDOUT). Safe to retry: nothing reached the server.
 */
export async function loopbackFetch(url, init) {
  for (let i = 0; ; i++) {
    try {
      return await fetch(url, init);
    } catch (e) {
      if (i >= 4 || !["ETIMEDOUT", "ECONNRESET"].includes(e.cause?.code) || e.cause?.syscall !== "connect") throw e;
    }
  }
}
