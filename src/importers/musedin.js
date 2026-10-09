// Importer for MusedIn (musedin.com): reads a member's public profile and work page.
// GET <base>/api/muse/<id> and GET <base>/api/muse/<id>/work; no key needed.

const ID = /^(muse|agent)_[a-z0-9]{6,40}$/;
const HOSTS = new Set(["musedin.com", "www.musedin.com", "musedin.pages.dev"]);

/** @param {string} ref a muse_id / agent_ id or a profile URL. @returns {string|null} the id */
export function parseRef(ref) {
  const s = String(ref ?? "").trim();
  if (ID.test(s)) return s;
  let u;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (!HOSTS.has(u.hostname)) return null;
  const m = /^\/(?:m|i|verify)\/((?:muse|agent)_[a-z0-9]{6,40})(?:\/|$)/.exec(u.pathname);
  return m ? m[1] : null;
}

const iso = (ms) => (typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : undefined);

async function getJson(fetchFn, url, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let res;
  try {
    res = await fetchFn(url, { headers: { accept: "application/json", "user-agent": "rostra (agent resource management)" }, signal: ctl.signal, redirect: "error" });
  } catch (e) {
    throw new Error(`could not reach ${url}: ${e.name === "AbortError" ? "timed out" : e.message}`);
  } finally {
    clearTimeout(timer);
  }
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* not JSON */
  }
  if (res.status === 404) {
    const err = new Error(body?.error ? `MusedIn: ${body.error}` : "MusedIn: no such member");
    err.status = 404;
    throw err;
  }
  if (!res.ok || !body || body.ok === false) throw new Error(`MusedIn answered ${res.status}${body?.error ? `: ${body.error}` : ""}`);
  return body;
}

/** Turn MusedIn's profile and work answers into Rostra's import shape. Exported for tests. */
export function mapMusedIn(id, profile, work, base) {
  const m = profile.muse || {};
  const abs = (p) => (p ? (/^https?:\/\//.test(p) ? p : base + (p.startsWith("/") ? p : "/" + p)) : null);
  const agent = {
    name: m.name || id,
    source: "musedin",
    source_ref: id,
    profile_url: `${base}/m/${id}`,
    skills: Array.isArray(m.skills) ? m.skills.filter((s) => typeof s === "string").slice(0, 50) : [],
    availability: m.open_to_work ? "open to work" : null,
    notes: m.headline ? String(m.headline).slice(0, 500) : null,
  };
  const items = Array.isArray(work?.items) ? work.items : [];
  const hires = [];
  const receipts = [];
  for (const it of items) {
    if (it?.kind === "hire" && it.status !== "declined") hires.push(it);
    else if (it?.kind === "receipt") receipts.push(it);
  }
  const engagements = [];
  const byRole = new Map();
  for (const h of hires) {
    const evidence = [abs(h.evidence), h.delivery?.url ? abs(h.delivery.url) : null, h.delivery?.post ? `${base}/p/${h.delivery.post}` : null].filter(Boolean);
    const delivered = !!(h.delivery && (h.delivery.url || h.delivery.post));
    const e = {
      title: String(h.title || h.role || "Hire").slice(0, 200),
      stage: delivered ? "delivered" : "hired",
      at: iso(delivered ? h.at : h.hired_at),
      dates: { hired: iso(h.hired_at) },
      evidence,
      source_ref: `musedin:hire:${h.id}`,
    };
    engagements.push(e);
    if (h.role && !byRole.has(h.role)) byRole.set(h.role, e);
  }
  for (const r of receipts) {
    const amount = r.amount_usd ? `${r.amount_usd} USD` : r.amount_sats ? `${r.amount_sats} sats` : null;
    const evidence = [r.url && /^https?:\/\//.test(r.url) ? r.url : null].filter(Boolean);
    const hire = r.role && byRole.get(r.role);
    if (hire && hire.stage !== "paid") {
      hire.dates = { ...hire.dates, [hire.stage]: hire.at };
      hire.stage = "paid";
      hire.at = iso(r.at);
      hire.amount = amount;
      hire.evidence = [...hire.evidence, ...evidence];
      continue;
    }
    engagements.push({
      title: String(r.title || "Paid work").slice(0, 200),
      stage: "paid",
      at: iso(r.at),
      amount,
      evidence,
      source_ref: `musedin:receipt:${r.id}`,
    });
  }
  return { agent, engagements, counts: work?.counts || null };
}

/** @type {import("./index.js").Importer} */
export const musedin = {
  name: "musedin",
  description: "MusedIn member by muse_id, agent_ id or profile URL",
  match: (ref) => parseRef(ref) !== null,
  async read(ref, { fetch: fetchFn = globalThis.fetch, base = process.env.ROSTRA_MUSEDIN_URL || "https://musedin.com", timeoutMs = 10000 } = {}) {
    const id = parseRef(ref);
    if (!id) throw new Error(`not a MusedIn id or profile URL: ${ref}`);
    const b = String(base).replace(/\/+$/, "");
    const profile = await getJson(fetchFn, `${b}/api/muse/${id}`, timeoutMs);
    const work = await getJson(fetchFn, `${b}/api/muse/${id}/work`, timeoutMs);
    return mapMusedIn(id, profile, work, b);
  },
};
