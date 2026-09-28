import type { Plugin } from "@opencode-ai/plugin"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { veilHome } from "./audit"
import { checkBinary } from "./gitleaks"
import { createScanner, type Logger } from "./scan"
import { collectTargets } from "./targets-v1"

// v1 entrypoint, reached through the package's default export `server`.
// Redacts the outgoing message array via the transform hook. Persisted history
// is left raw.
export const server: Plugin = async ({ client, directory }) => {
  const log: Logger = (level, message, extra) =>
    client.app
      .log({ body: { service: "veil", level, message, extra }, query: { directory } })
      .then(() => {})

  mkdirSync(veilHome(), { recursive: true })
  const auditPath = join(veilHome(), "audit.jsonl")

  const binaryOk = await checkBinary()
  if (!binaryOk) {
    await log("warn", "gitleaks binary not found; prompt-veil disabled (pass-through)")
  }

  const { scanEach } = createScanner({ log, auditPath })

  return {
    "experimental.chat.messages.transform": async (_input, output) => {
      if (!binaryOk) return
      await scanEach(collectTargets(output.messages))
    },
  }
}
