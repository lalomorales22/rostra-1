// SQLite file, opened with node:sqlite. Migrations are plain SQL files in
// ../migrations, applied in name order and recorded in schema_migrations.
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

/**
 * Open (or create) a database and bring it to the latest migration.
 * @param {string} path a file path, or ":memory:"
 * @returns {DatabaseSync}
 */
export function openDb(path = ":memory:") {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
  migrate(db);
  return db;
}

/** @param {DatabaseSync} db @returns {string[]} names applied now */
export function migrate(db) {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
  const done = new Set(db.prepare("SELECT name FROM schema_migrations").all().map((r) => r.name));
  const applied = [];
  for (const name of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
    if (done.has(name)) continue;
    const sql = readFileSync(join(MIGRATIONS, name), "utf8");
    db.exec("BEGIN");
    try {
      db.exec(sql);
      db.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)").run(name, new Date().toISOString());
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw new Error(`migration ${name} failed: ${e.message}`);
    }
    applied.push(name);
  }
  return applied;
}
