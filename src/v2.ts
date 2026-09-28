import type { Message } from "@opencode/ai"
import type { Plugin } from "@opencode/plugin"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { veilHome } from "./audit"
import { checkBinary } from "./gitleaks"
import { createScanner, type Logger } from "./scan"
import { collectTargetsV2 } from "./targets-v2"

// v2 entrypoint, reached through the package's default export `setup`.
// Redacts the outgoing model request for every request kind; like v1 this only
// affects the outgoing call, never persisted history.
export async function setup(ctx: Plugin.Context): Promise<Plugin.Cleanup> {
  const log: Logger = (level, message, extra) => {
    const line = `[veil] ${message}`
    if (level === "error") console.error(line, extra ?? "")
    else if (level === "warn") console.warn(line, extra ?? "")
    else console.info(line, extra ?? "")
  }

  mkdirSync(veilHome(), { recursive: true })
  const auditPath = join(veilHome(), "audit.jsonl")

  const binaryOk = await checkBinary()
  if (!binaryOk) {
    log("warn", "gitleaks binary not found; prompt-veil disabled (pass-through)")
  }

  const { scanEach } = createScanner({ log, auditPath })

  const redact = async (event: { messages: Array<Message> }): Promise<void> => {
    if (!binaryOk) return
    await scanEach(collectTargetsV2(event.messages))
  }

  // Every model request kind shares the same transcript, so one handler covers
  // the agent loop and the auxiliary compaction, generate, and title requests.
  const registrations = await Promise.all([
    ctx.session.hook("context", redact),
    ctx.session.hook("compaction", redact),
    ctx.session.hook("generate", redact),
    ctx.session.hook("title", redact),
  ])

  return async () => {
    for (const registration of registrations) await registration.dispose()
  }
}
