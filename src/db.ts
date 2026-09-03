import {mkdirSync} from "node:fs";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";

// Single SQLite file shared by the directory tables and the document persistence
// tables. Keeping one connection means folders, documents, snapshots, and update
// logs all live in one file and participate in the same transactions.
export const dataDir = path.resolve(process.env.DATA_DIR ?? "data");
mkdirSync(dataDir, {recursive: true});

export const database = new DatabaseSync(path.join(dataDir, "editor.sqlite"));
database.exec("PRAGMA foreign_keys = ON;");
