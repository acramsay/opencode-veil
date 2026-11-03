import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { statsFor } from "./rpc"
import { openDb, recordRedaction } from "./store"

const tempDb = () => join(mkdtempSync(join(tmpdir(), "veil-rpc-")), "veil.db")

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

describe("statsFor", () => {
  test("sums the root's redactions and passes health through", () => {
    const dbPath = tempDb()
    recordRedaction(openDb(dbPath), event({ secrets: 2 }))
    recordRedaction(openDb(dbPath), event({ secrets: 3, partID: "p2" }))
    expect(statsFor(openDb(dbPath), true, "root")).toEqual({ healthy: true, redactions: 5 })
  })

  test("passes healthy through unchanged", () => {
    expect(statsFor(openDb(tempDb()), false, "root")).toEqual({ healthy: false, redactions: 0 })
  })

  test("returns zero for an unknown root", () => {
    expect(statsFor(openDb(tempDb()), true, "absent").redactions).toBe(0)
  })
})
