// Importers read an agent from somewhere else and return Rostra's import shape:
//   { agent: { name, source, source_ref, profile_url?, skills?, availability?, notes? },
//     engagements?: [{ title, stage, at?, dates?, amount?, evidence?, source_ref }] }
// To add a source (Moltbook, The Colony, an A2A agent card, ...): write a module like
// musedin.js exporting { name, description, match(ref), read(ref, opts) } and list it here.
import { musedin } from "./musedin.js";
import { musedinRecord } from "./musedin-record.js";
import { RostraError } from "../store.js";

/**
 * @typedef {object} Importer
 * @property {string} name
 * @property {string} description
 * @property {(ref: string) => boolean} match
 * @property {(ref: string, opts?: {fetch?: typeof fetch, base?: string, timeoutMs?: number}) => Promise<{agent: object, engagements?: object[]}>} read
 */

/** @type {Importer[]} */
export const IMPORTERS = [musedin, musedinRecord];

/** Pick the importer by name, or the first one whose match(ref) is true. */
export function importerFor(ref, name) {
  if (name) {
    const imp = IMPORTERS.find((i) => i.name === name);
    if (!imp) throw new RostraError(`no importer ${name}; known: ${IMPORTERS.map((i) => i.name).join(", ")}`);
    return imp;
  }
  const imp = IMPORTERS.find((i) => i.match(ref));
  if (!imp) throw new RostraError(`no importer reads ${ref}; known: ${IMPORTERS.map((i) => `${i.name} (${i.description})`).join("; ")}`);
  return imp;
}

/**
 * Read an agent with an importer and save it in the store.
 * @param {import("../store.js").Store} store
 * @param {string} ref
 * @param {{source?: string, fetch?: typeof fetch, base?: string}} [opts]
 */
export async function importAgent(store, ref, opts = {}) {
  const imp = importerFor(ref, opts.source);
  if (!imp.match(ref)) throw new RostraError(`${imp.name} cannot read ${ref}`);
  let data;
  try {
    data = await imp.read(ref, opts);
  } catch (e) {
    throw new RostraError(e.message, e.status === 404 ? 404 : 502);
  }
  return { source: imp.name, ...store.saveImport(data) };
}
