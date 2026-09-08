import { homedir } from "node:os"
import { join } from "node:path"

export const veilHome = join(
  process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"),
  "veil",
)

export type AuditEvent = {
  ts: number
  outcome: "redact" | "clean" | "fail-open"
  kind: "text" | "tool"
  messageID: string
  partID: string
  scanMs?: number
  rules?: string[]
  error?: string
}

export async function appendAudit(path: string, event: AuditEvent): Promise<void> {
  try {
    const { appendFile } = await import("node:fs/promises")
    await appendFile(path, JSON.stringify(event) + "\n")
  } catch {}
}
