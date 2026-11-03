import type { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { redactText, scanText, type Finding } from "./gitleaks"
import { recordRedaction, type RedactionEvent } from "./store"

export type Logger = (
  level: "info" | "warn" | "error",
  message: string,
  extra?: Record<string, unknown>,
) => void | Promise<void>

export type ScanTarget = {
  partID: string
  messageID: string
  sessionID: string
  kind: "text" | "tool"
  get: () => string
  set: (v: string) => void
}

// Scans each span through gitleaks and splices findings out as
// `[REDACTED:<rule>]`. Results are cached by content hash and re-applied on
// every call: the outgoing transcript is rebuilt from raw history each model
// call, so a secret reappears and must be re-redacted every time. Caching the
// *result* rather than skipping the span keeps that correct while still paying
// the gitleaks cost once per unique span.
// Fail-open: any scan or store error logs and passes the text through untouched.
export function createScanner(opts: {
  log: Logger
  db: Database
  getParentID: (sessionID: string) => Promise<string | null>
  // Injectable for tests; production uses the real gitleaks pipeline.
  scan?: (text: string) => Promise<Finding[]>
  redact?: (text: string, findings: Finding[]) => string
  onRedact?: (event: RedactionEvent) => void
}) {
  const { log, db, getParentID, scan = scanText, redact = redactText, onRedact } = opts
  const cache = new Map<string, string>()
  const roots = new Map<string, string>()

  // Walks parentID to the top, memoizing every session on the path so each
  // distinct session costs at most one lookup. Failure attributes the span to
  // the scanning session rather than throwing.
  async function resolveRoot(sessionID: string): Promise<string> {
    const cached = roots.get(sessionID)
    if (cached !== undefined) return cached
    const path: string[] = []
    let id = sessionID
    try {
      for (;;) {
        const known = roots.get(id)
        if (known !== undefined) {
          id = known
          break
        }
        path.push(id)
        const parent = await getParentID(id)
        if (!parent) break
        id = parent
      }
      for (const visited of path) roots.set(visited, id)
      return id
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      await log("warn", "root session lookup failed; attributing redaction to the scanning session", {
        sessionID,
        error: reason,
      })
      roots.set(sessionID, sessionID)
      return sessionID
    }
  }

  async function scanOne(target: ScanTarget): Promise<void> {
    try {
      const text = target.get()
      const key = createHash("sha256").update(text).digest("hex")
      const cached = cache.get(key)
      if (cached !== undefined) {
        if (cached !== text) target.set(cached)
        return
      }
      const findings = await scan(text)
      if (findings.length === 0) {
        cache.set(key, text)
        return
      }
      const redacted = redact(text, findings)
      cache.set(key, redacted)
      target.set(redacted)
      const rules = [...new Set(findings.map((f) => f.rule))]
      await log("info", "secrets redacted from outgoing prompt", {
        kind: target.kind,
        partID: target.partID,
        rules,
      })
      try {
        const rootID = await resolveRoot(target.sessionID)
        const event: RedactionEvent = {
          rootID,
          sessionID: target.sessionID,
          messageID: target.messageID,
          partID: target.partID,
          kind: target.kind,
          secrets: findings.length,
          rules,
        }
        recordRedaction(db, event)
        onRedact?.(event)
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        await log("error", "redaction store write failed; continuing (fail-open)", {
          kind: target.kind,
          partID: target.partID,
          error: reason,
        })
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      await log("error", "prompt scan failed; passing through (fail-open)", {
        kind: target.kind,
        partID: target.partID,
        error: reason,
      })
    }
  }

  async function scanEach(targets: ScanTarget[]): Promise<void> {
    for (const target of targets) await scanOne(target)
  }

  return { scanEach }
}
