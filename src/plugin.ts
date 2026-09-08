import type { Plugin } from "@opencode-ai/plugin"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { appendAudit, veilHome } from "./audit"
import { checkBinary, redactText, scanText } from "./gitleaks"
import { collectTargets, type ScanTarget } from "./targets"

type Logger = (level: "info" | "warn" | "error", message: string, extra?: Record<string, unknown>) => Promise<void>

// Redacts secrets from outgoing messages via gitleaks over stdin. Scans user
// text parts and completed tool outputs; everything else stays untouched.
// Part IDs are memoized so each span is scanned once per server process —
// a reprocessed span (post-redaction) passes clean anyway.
// Fail-open: any scan error logs and passes the text through untouched.
export const Veil: Plugin = async ({ client, directory }) => {
  const log: Logger = (level, message, extra) =>
    client.app
      .log({ body: { service: "veil", level, message, extra }, query: { directory } })
      .then(() => {})

  mkdirSync(veilHome, { recursive: true })
  const auditPath = join(veilHome, "audit.jsonl")

  const binaryOk = await checkBinary()
  if (!binaryOk) {
    await log("warn", "gitleaks binary not found; prompt-veil disabled (pass-through)")
  }

  const scanned = new Set<string>()

  return {
    "experimental.chat.messages.transform": async (_input, output) => {
      if (!binaryOk) return
      const targets = collectTargets(output.messages)
      for (const target of targets) {
        if (scanned.has(target.partID)) continue
        scanned.add(target.partID)
        await scanOne(target, log, auditPath)
      }
    },
  }
}

async function scanOne(
  target: ScanTarget,
  log: Logger,
  auditPath: string,
): Promise<void> {
  const started = Date.now()
  const base = { kind: target.kind, messageID: target.messageID, partID: target.partID }
  try {
    const findings = await scanText(target.get())
    const scanMs = Date.now() - started
    if (findings.length === 0) {
      await appendAudit(auditPath, { ts: Date.now(), ...base, outcome: "clean", scanMs })
      return
    }
    target.set(redactText(target.get(), findings))
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
