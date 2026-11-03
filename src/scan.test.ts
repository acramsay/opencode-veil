import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Finding } from "./gitleaks"
import { createScanner, type Logger, type ScanTarget } from "./scan"
import { openDb, type RedactionEvent } from "./store"

const dbPath = () => join(mkdtempSync(join(tmpdir(), "veil-scan-")), "veil.db")

type Row = {
  root_id: string
  session_id: string
  message_id: string | null
  part_id: string
  kind: string
  secrets: number
  rules: string
}

const readRows = (path: string): Row[] =>
  openDb(path).query<Row, []>("SELECT * FROM veil_events ORDER BY id").all()

function makeTarget(text: string, opts: { partID?: string; sessionID?: string } = {}) {
  const ref = { text }
  const target: ScanTarget = {
    partID: opts.partID ?? "p",
    messageID: "m",
    sessionID: opts.sessionID ?? "s1",
    kind: "text",
    get: () => ref.text,
    set: (v) => { ref.text = v },
  }
  return { target, ref }
}

const captureLog = () => {
  const lines: Array<{ level: string; message: string }> = []
  const log: Logger = (level, message) => { lines.push({ level, message }) }
  return { log, lines }
}

const redactRule = (text: string, findings: Finding[]) =>
  findings.reduce((out, f) => out.split(f.match).join(`[REDACTED:${f.rule}]`), text)

const noParent = async () => null

describe("createScanner", () => {
  test("redacts, logs, and records an unclean span", async () => {
    const path = dbPath()
    const { log, lines } = captureLog()
    let calls = 0
    const scanner = createScanner({
      log,
      db: openDb(path),
      getParentID: noParent,
      scan: async () => { calls++; return [{ rule: "github-pat", match: "secret" }] },
      redact: redactRule,
    })
    const { target, ref } = makeTarget("has secret here")
    await scanner.scanEach([target])

    expect(ref.text).toBe("has [REDACTED:github-pat] here")
    expect(calls).toBe(1)
    expect(lines).toEqual([{ level: "info", message: "secrets redacted from outgoing prompt" }])
    const rows = readRows(path)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      root_id: "s1",
      session_id: "s1",
      message_id: "m",
      part_id: "p",
      kind: "text",
      secrets: 1,
      rules: '["github-pat"]',
    })
  })

  test("re-applies cached redaction to a fresh span without rescanning or re-recording", async () => {
    // Regression: v2 rebuilds the outgoing transcript from raw history each model
    // call, so the same raw secret returns. A skip-based memo would leak it; the
    // content cache must instead re-apply the redaction.
    const path = dbPath()
    const { log } = captureLog()
    let calls = 0
    const scanner = createScanner({
      log,
      db: openDb(path),
      getParentID: noParent,
      scan: async () => { calls++; return [{ rule: "github-pat", match: "secret" }] },
      redact: redactRule,
    })
    const first = makeTarget("has secret")
    await scanner.scanEach([first.target])
    expect(first.ref.text).toBe("has [REDACTED:github-pat]")

    const second = makeTarget("has secret")
    await scanner.scanEach([second.target])
    expect(second.ref.text).toBe("has [REDACTED:github-pat]")
    expect(calls).toBe(1)
    // One row: the cache hit is a re-apply, not a new scan.
    expect(readRows(path)).toHaveLength(1)
  })

  test("caches clean spans but does not record them", async () => {
    const path = dbPath()
    const { log, lines } = captureLog()
    let calls = 0
    const scanner = createScanner({
      log,
      db: openDb(path),
      getParentID: noParent,
      scan: async () => { calls++; return [] },
      redact: redactRule,
    })
    const { target, ref } = makeTarget("nothing to see")
    await scanner.scanEach([target])
    expect(ref.text).toBe("nothing to see")
    await scanner.scanEach([makeTarget("nothing to see").target])
    expect(calls).toBe(1)
    expect(lines).toEqual([])
    expect(readRows(path)).toHaveLength(0)
  })

  test("dedupes identical content across targets in one call", async () => {
    const path = dbPath()
    const { log } = captureLog()
    let calls = 0
    const scanner = createScanner({
      log,
      db: openDb(path),
      getParentID: noParent,
      scan: async () => { calls++; return [{ rule: "r", match: "secret" }] },
      redact: redactRule,
    })
    await scanner.scanEach([makeTarget("secret", { partID: "a" }).target, makeTarget("secret", { partID: "b" }).target])
    expect(calls).toBe(1)
  })

  test("fails open on a scanner error: text passes through, nothing is recorded", async () => {
    const path = dbPath()
    const { log, lines } = captureLog()
    const scanner = createScanner({
      log,
      db: openDb(path),
      getParentID: noParent,
      scan: async () => { throw new Error("gitleaks blew up") },
      redact: redactRule,
    })
    const { target, ref } = makeTarget("has secret")
    await scanner.scanEach([target])

    expect(ref.text).toBe("has secret")
    expect(lines).toEqual([{ level: "error", message: "prompt scan failed; passing through (fail-open)" }])
    expect(readRows(path)).toHaveLength(0)
  })

  test("scans multiple targets independently", async () => {
    const path = dbPath()
    const { log } = captureLog()
    const scanner = createScanner({
      log,
      db: openDb(path),
      getParentID: noParent,
      scan: async (text) => (text.includes("secret") ? [{ rule: "r", match: "secret" }] : []),
      redact: redactRule,
    })
    const dirty = makeTarget("a secret b")
    const clean = makeTarget("all clear")
    await scanner.scanEach([dirty.target, clean.target])
    expect(dirty.ref.text).toBe("a [REDACTED:r] b")
    expect(clean.ref.text).toBe("all clear")
    expect(readRows(path).map((r) => r.part_id)).toEqual(["p"])
  })

  test("rolls a subagent's redaction up to its root session", async () => {
    const path = dbPath()
    const { log } = captureLog()
    const parents: Record<string, string | null> = { child: "root", root: null }
    const scanner = createScanner({
      log,
      db: openDb(path),
      getParentID: async (id) => parents[id] ?? null,
      scan: async () => [{ rule: "r", match: "secret" }],
      redact: redactRule,
    })
    await scanner.scanEach([makeTarget("secret", { sessionID: "child" }).target])

    const rows = readRows(path)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ root_id: "root", session_id: "child" })
  })

  test("memoizes root resolution across scans of the same session", async () => {
    const path = dbPath()
    const { log } = captureLog()
    let lookups = 0
    const scanner = createScanner({
      log,
      db: openDb(path),
      getParentID: async (id) => { lookups++; return id === "child" ? "root" : null },
      scan: async (text) => (text.includes("secret") ? [{ rule: "r", match: "secret" }] : []),
      redact: redactRule,
    })
    await scanner.scanEach([makeTarget("secret one", { sessionID: "child" }).target])
    await scanner.scanEach([makeTarget("secret two", { sessionID: "child" }).target])
    expect(lookups).toBe(2) // child -> root, root -> null; second scan hits the memo.
  })

  test("falls back to the scanning session when root lookup fails", async () => {
    const path = dbPath()
    const { log, lines } = captureLog()
    const scanner = createScanner({
      log,
      db: openDb(path),
      getParentID: async () => { throw new Error("session gone") },
      scan: async () => [{ rule: "r", match: "secret" }],
      redact: redactRule,
    })
    await scanner.scanEach([makeTarget("secret", { sessionID: "orphan" }).target])

    expect(readRows(path)[0]).toMatchObject({ root_id: "orphan", session_id: "orphan" })
    expect(lines.some((l) => l.level === "warn")).toBe(true)
  })

  test("invokes onRedact with the resolved root after recording", async () => {
    const path = dbPath()
    const { log } = captureLog()
    const events: RedactionEvent[] = []
    const scanner = createScanner({
      log,
      db: openDb(path),
      getParentID: async (id) => (id === "child" ? "root" : null),
      scan: async () => [{ rule: "r", match: "secret" }],
      redact: redactRule,
      onRedact: (e) => events.push(e),
    })
    await scanner.scanEach([makeTarget("secret", { sessionID: "child" }).target])
    expect(events).toEqual([
      {
        rootID: "root",
        sessionID: "child",
        messageID: "m",
        partID: "p",
        kind: "text",
        secrets: 1,
        rules: ["r"],
      },
    ])
  })
})
