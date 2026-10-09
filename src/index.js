// Library entry: open a store and use it from your own code.
import { homedir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db.js";
import { Store } from "./store.js";

export { Store, RostraError, AGENT_STATUSES, STAGES } from "./store.js";
export { openDb, migrate } from "./db.js";
export { createMcpServer } from "./mcp.js";
export { createHttpHandler, startHttp } from "./http.js";
export { IMPORTERS, importAgent, importerFor } from "./importers/index.js";

/** The database file: ROSTRA_DB, else ~/.rostra/rostra.db. */
export function defaultDbPath() {
  return process.env.ROSTRA_DB || join(homedir(), ".rostra", "rostra.db");
}

/** @param {string} [path] */
export function openStore(path = defaultDbPath()) {
  return new Store(openDb(path));
}
