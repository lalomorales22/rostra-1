// Importer for MusedIn's signed agent record:
// GET <base>/api/muse/<id>/record (public, no key). The answer wraps the
// record as a JSON string in `payload` (signed; signature in `signature`).
// This importer reads the record only — it does not verify the signature —
// and maps the record's hires into Rostra engagements. It is the complement
// to musedin.js, which reads the profile and work pages instead.

import { parseRef } from "./musedin.js";

const iso = (ms) => (typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : undefined);

async function getRecord(fetchFn, url, timeoutMs) {
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
  let record;
  try {
    record = typeof body.payload === "string" ? JSON.parse(body.payload) : body.payload;
  } catch {
    throw new Error("MusedIn record payload is not JSON");
  }
  if (!record || typeof record !== "object" || !Array.isArray(record.hires)) {
    throw new Error("MusedIn record has no hires list");
  }
  return record;
}

function amountOf(payment) {
  if (!payment) return null;
  if (typeof payment === "string") return payment.slice(0, 100);
  if (typeof payment === "object") {
    if (payment.amount_usd) return `${payment.amount_usd} USD`;
    if (payment.amount_sats) return `${payment.amount_sats} sats`;
    if (payment.amount) return String(payment.amount).slice(0, 100);
  }
  return null;
}

/** Turn a MusedIn record answer into Rostra's import shape. Exported for tests. */
export function mapMusedInRecord(id, record, base) {
  const agent = {
    name: record.name || id,
    source: "musedin",
    source_ref: id,
    profile_url: `${base}/m/${id}`,
  };
  const engagements = [];
  for (const [i, h] of record.hires.entries()) {
    if (!h || h.status === "declined") continue;
    // Record hires carry no id field; the record URL names the hire.
    const m = /\/hire\/(\d+)$/.exec(h.record_url || "");
    const ref = m ? `musedin:hire:${m[1]}` : h.id != null ? `musedin:hire:${h.id}` : `musedin:hire:${h.role || i}`;
    const delivered = h.settlement === "delivered" || !!h.delivery_url;
    const accepted = h.settlement === "accepted";
    const amount = amountOf(h.payment);
    const stage = amount || h.settlement === "paid" ? "paid" : accepted ? "accepted" : delivered ? "delivered" : "hired";
    const evidence = [h.record_url, h.delivery_url].filter((u) => typeof u === "string" && u);
    engagements.push({
      title: String(h.title || h.role || "Hire").slice(0, 200),
      stage,
      at: iso(h.hired_at),
      dates: { hired: iso(h.hired_at) },
      ...(amount ? { amount } : {}),
      evidence,
      source_ref: ref,
    });
  }
  return { agent, engagements, counts: record.counts || null };
}

/** @type {import("./index.js").Importer} */
export const musedinRecord = {
  name: "musedin-record",
  description: "MusedIn agent record by muse_id (GET /api/muse/<id>/record)",
  match: (ref) => parseRef(ref) !== null,
  async read(ref, { fetch: fetchFn = globalThis.fetch, base = process.env.ROSTRA_MUSEDIN_URL || "https://musedin.com", timeoutMs = 10000 } = {}) {
    const id = parseRef(ref);
    if (!id) throw new Error(`not a MusedIn id or profile URL: ${ref}`);
    const b = String(base).replace(/\/+$/, "");
    const record = await getRecord(fetchFn, `${b}/api/muse/${id}/record`, timeoutMs);
    return mapMusedInRecord(id, record, b);
  },
};
