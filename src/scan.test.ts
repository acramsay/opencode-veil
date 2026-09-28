import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Finding } from "./gitleaks"
import { createScanner, type Logger, type ScanTarget } from "./scan"

const auditDir = () => mkdtempSync(join(tmpdir(), "veil-scan-"))
const auditPath = () => join(auditDir(), "audit.jsonl")

const readAudit = async (path: string) =>
  (await Bun.file(path).text())
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>)

function makeTarget(text: string, partID = "p") {
  const ref = { text }
  const target: ScanTarget = {
    partID,
    messageID: "m",
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

describe("createScanner", () => {
  test("redacts, logs, and audits an unclean span", async () => {
    const path = auditPath()
    const { log, lines } = captureLog()
    let calls = 0
    const scanner = createScanner({
      log,
      auditPath: path,
      scan: async () => { calls++; return [{ rule: "github-pat", match: "secret" }] },
      redact: redactRule,
    })
    const { target, ref } = makeTarget("has secret here")
    await scanner.scanEach([target])

    expect(ref.text).toBe("has [REDACTED:github-pat] here")
    expect(calls).toBe(1)
    expect(lines).toEqual([{ level: "info", message: "secrets redacted from outgoing prompt" }])
    const audit = await readAudit(path)
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ outcome: "redact", kind: "text", partID: "p", rules: ["github-pat"] })
  })

  test("re-applies cached redaction to a fresh span without rescanning", async () => {
    // Regression: v2 rebuilds the outgoing transcript from raw history each model
    // call, so the same raw secret returns. A skip-based memo would leak it; the
    // content cache must instead re-apply the redaction.
    const path = auditPath()
    const { log } = captureLog()
    let calls = 0
    const scanner = createScanner({
      log,
      auditPath: path,
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
    // One audit line: the cache hit is a re-apply, not a new scan.
    expect(await readAudit(path)).toHaveLength(1)
  })

  test("audits clean spans and caches them", async () => {
    const path = auditPath()
    const { log } = captureLog()
    let calls = 0
    const scanner = createScanner({
      log,
      auditPath: path,
      scan: async () => { calls++; return [] },
      redact: redactRule,
    })
    const { target, ref } = makeTarget("nothing to see")
    await scanner.scanEach([target])
    expect(ref.text).toBe("nothing to see")
    await scanner.scanEach([makeTarget("nothing to see").target])
    expect(calls).toBe(1)
    expect((await readAudit(path))[0]).toMatchObject({ outcome: "clean" })
  })

  test("dedupes identical content across targets in one call", async () => {
    const path = auditPath()
    const { log } = captureLog()
    let calls = 0
    const scanner = createScanner({
      log,
      auditPath: path,
      scan: async () => { calls++; return [{ rule: "r", match: "secret" }] },
      redact: redactRule,
    })
    await scanner.scanEach([makeTarget("secret", "a").target, makeTarget("secret", "b").target])
    expect(calls).toBe(1)
  })

  test("fails open on a scanner error: text passes through, audit records it", async () => {
    const path = auditPath()
    const { log, lines } = captureLog()
    const scanner = createScanner({
      log,
      auditPath: path,
      scan: async () => { throw new Error("gitleaks blew up") },
      redact: redactRule,
    })
    const { target, ref } = makeTarget("has secret")
    await scanner.scanEach([target])

    expect(ref.text).toBe("has secret")
    expect(lines).toEqual([{ level: "error", message: "prompt scan failed; passing through (fail-open)" }])
    expect((await readAudit(path))[0]).toMatchObject({ outcome: "fail-open", error: "gitleaks blew up" })
  })

  test("scans multiple targets independently", async () => {
    const path = auditPath()
    const { log } = captureLog()
    const scanner = createScanner({
      log,
      auditPath: path,
      scan: async (text) => (text.includes("secret") ? [{ rule: "r", match: "secret" }] : []),
      redact: redactRule,
    })
    const dirty = makeTarget("a secret b")
    const clean = makeTarget("all clear")
    await scanner.scanEach([dirty.target, clean.target])
    expect(dirty.ref.text).toBe("a [REDACTED:r] b")
    expect(clean.ref.text).toBe("all clear")
    expect((await readAudit(path)).map((e) => e.outcome)).toEqual(["redact", "clean"])
  })
})
