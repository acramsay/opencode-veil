import { createHash } from "node:crypto"
import { appendAudit } from "./audit"
import { redactText, scanText, type Finding } from "./gitleaks"

export type Logger = (
  level: "info" | "warn" | "error",
  message: string,
  extra?: Record<string, unknown>,
) => void | Promise<void>

export type ScanTarget = {
  partID: string
  messageID: string
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
// Fail-open: any scan error logs and passes the text through untouched.
export function createScanner(opts: {
  log: Logger
  auditPath: string
  // Injectable for tests; production uses the real gitleaks pipeline.
  scan?: (text: string) => Promise<Finding[]>
  redact?: (text: string, findings: Finding[]) => string
}) {
  const { log, auditPath, scan = scanText, redact = redactText } = opts
  const cache = new Map<string, string>()

  async function scanOne(target: ScanTarget): Promise<void> {
    const started = Date.now()
    const base = { kind: target.kind, messageID: target.messageID, partID: target.partID }
    try {
      const text = target.get()
      const key = createHash("sha256").update(text).digest("hex")
      const cached = cache.get(key)
      if (cached !== undefined) {
        if (cached !== text) target.set(cached)
        return
      }
      const findings = await scan(text)
      const scanMs = Date.now() - started
      if (findings.length === 0) {
        cache.set(key, text)
        await appendAudit(auditPath, { ts: Date.now(), ...base, outcome: "clean", scanMs })
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
      await appendAudit(auditPath, { ts: Date.now(), ...base, outcome: "redact", scanMs, rules })
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      await log("error", "prompt scan failed; passing through (fail-open)", {
        kind: target.kind,
        partID: target.partID,
        error: reason,
      })
      await appendAudit(auditPath, { ts: Date.now(), ...base, outcome: "fail-open", error: reason })
    }
  }

  async function scanEach(targets: ScanTarget[]): Promise<void> {
    for (const target of targets) await scanOne(target)
  }

  return { scanEach }
}
