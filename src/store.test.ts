import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { countRedactions, deleteSessionEvents, openDb, recordRedaction } from "./store"

const tempDb = () => join(mkdtempSync(join(tmpdir(), "veil-store-")), "veil.db")

const event = (overrides: Partial<Parameters<typeof recordRedaction>[1]> = {}) => ({
  rootID: "root",
  sessionID: "root",
  messageID: "m1",
  partID: "p1",
  kind: "text" as const,
  secrets: 1,
  rules: ["github-pat"],
  ...overrides,
})

describe("store", () => {
  test("records a redaction and counts it under its root", () => {
    const db = openDb(tempDb())
    recordRedaction(db, event())
    expect(countRedactions(db, "root")).toBe(1)
  })

  test("sums secrets across rows for a root", () => {
    const db = openDb(tempDb())
    recordRedaction(db, event({ secrets: 2 }))
    recordRedaction(db, event({ secrets: 3, partID: "p2" }))
    recordRedaction(db, event({ rootID: "other", sessionID: "other", secrets: 9 }))
    expect(countRedactions(db, "root")).toBe(5)
    expect(countRedactions(db, "other")).toBe(9)
    expect(countRedactions(db, "absent")).toBe(0)
  })

  test("deletes every row of a deleted root, including child contributions", () => {
    const db = openDb(tempDb())
    recordRedaction(db, event({ sessionID: "root" }))
    recordRedaction(db, event({ sessionID: "child" }))
    recordRedaction(db, event({ rootID: "keep", sessionID: "keep" }))
    deleteSessionEvents(db, "root")
    expect(countRedactions(db, "root")).toBe(0)
    expect(countRedactions(db, "keep")).toBe(1)
  })

  test("deletes a child's rows by session id without touching the root's own", () => {
    const db = openDb(tempDb())
    recordRedaction(db, event({ sessionID: "root" }))
    recordRedaction(db, event({ sessionID: "child" }))
    deleteSessionEvents(db, "child")
    const remaining = db
      .query<{ session_id: string }, []>("SELECT session_id FROM veil_events")
      .all()
    expect(remaining.map((r) => r.session_id)).toEqual(["root"])
  })

  test("reuses one handle per resolved path", () => {
    const path = tempDb()
    expect(openDb(path)).toBe(openDb(path))
    expect(openDb(path)).not.toBe(openDb(tempDb()))
  })
})
