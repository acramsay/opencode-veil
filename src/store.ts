import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"

function veilHome(): string {
  return join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "veil")
}

export function veilDbPath(): string {
  return join(veilHome(), "veil.db")
}

const SQLITE_BUSY_TIMEOUT_MS = 5000

export type Stats = {
  healthy: boolean
  redactions: number
}

export type RedactionEvent = {
  rootID: string
  sessionID: string
  messageID: string
  partID: string
  kind: "text" | "tool"
  secrets: number
  rules: string[]
}

// One handle per resolved path, so repeated openDb calls in this plugin instance
// reuse a connection. Each location loads its own module instance and so does not
// share one; WAL plus busy_timeout cover contention between them. The process owns
// the handle for its lifetime, so it is never closed.
const handles = new Map<string, Database>()

export function openDb(path: string): Database {
  const resolved = resolve(path)
  const existing = handles.get(resolved)
  if (existing) return existing
  mkdirSync(dirname(resolved), { recursive: true })
  const db = new Database(resolved, { create: true })
  db.run("PRAGMA journal_mode = WAL")
  db.run(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`)
  db.run(
    `CREATE TABLE IF NOT EXISTS veil_events (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      ts         INTEGER NOT NULL,
      root_id    TEXT    NOT NULL,
      session_id TEXT    NOT NULL,
      message_id TEXT,
      part_id    TEXT,
      kind       TEXT    NOT NULL,
      secrets    INTEGER NOT NULL,
      rules      TEXT    NOT NULL
    )`,
  )
  db.run("CREATE INDEX IF NOT EXISTS veil_events_root ON veil_events (root_id)")
  handles.set(resolved, db)
  return db
}

export function recordRedaction(db: Database, event: RedactionEvent): void {
  db.query(
    `INSERT INTO veil_events
      (ts, root_id, session_id, message_id, part_id, kind, secrets, rules)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    Date.now(),
    event.rootID,
    event.sessionID,
    event.messageID,
    event.partID,
    event.kind,
    event.secrets,
    JSON.stringify(event.rules),
  )
}

export function countRedactions(db: Database, rootID: string): number {
  const row = db
    .query<{ n: number }, [string]>(
      "SELECT COALESCE(SUM(secrets), 0) AS n FROM veil_events WHERE root_id = ?",
    )
    .get(rootID)
  return row?.n ?? 0
}

// A deleted root clears its rows; a deleted child clears its own, including rows
// it contributed to a parent's root.
export function deleteSessionEvents(db: Database, sessionID: string): void {
  db.query("DELETE FROM veil_events WHERE root_id = ? OR session_id = ?").run(sessionID, sessionID)
}
