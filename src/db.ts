import {mkdirSync} from "node:fs";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";

// Single SQLite file shared by the directory tables and the document persistence
// tables. Keeping one connection means folders, documents, snapshots, and update
// logs all live in one file and participate in the same transactions.
export const dataDir = path.resolve(process.env.DATA_DIR ?? "data");
mkdirSync(dataDir, {recursive: true});

export const database = new DatabaseSync(path.join(dataDir, "editor.sqlite"));

// Drop what the multi-user build left behind. This branch has no principals,
// tokens, sessions, ownership or sharing, so a database carrying those tables
// describes a model the code no longer implements — and a schema that disagrees
// with the app is how someone later concludes a feature still exists.
//
// Runs before any module creates its tables: on a fresh database every statement
// here is a no-op, and on an existing one it removes the columns and tables whose
// owning modules are gone. Foreign keys are off during the drops so removing a
// referenced table cannot fail on rows that are about to be irrelevant anyway.
const dropColumnIfPresent = (table: string, column: string) => {
  const exists = (database.prepare(`PRAGMA table_info(${table})`).all() as {name: string}[])
    .some((row) => row.name === column);
  if (exists) database.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
};

const tableExists = (name: string) =>
  database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;

database.exec("PRAGMA foreign_keys = OFF;");
for (const table of ["document_shares", "api_tokens", "sessions", "human_identities", "principals"]) {
  database.exec(`DROP TABLE IF EXISTS ${table}`);
}
if (tableExists("documents")) dropColumnIfPresent("documents", "owner_id");
if (tableExists("document_activity")) dropColumnIfPresent("document_activity", "author_id");
database.exec("PRAGMA foreign_keys = ON;");
