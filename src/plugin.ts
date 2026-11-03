import type { Message } from "@opencode/ai"
import type { Plugin } from "@opencode/plugin"
import { checkBinary } from "./gitleaks"
import { registerVeil } from "./rpc"
import { createScanner, type Logger } from "./scan"
import { countRedactions, deleteSessionEvents, openDb, veilDbPath } from "./store"
import { collectTargets } from "./targets"

// Redacts the outgoing model request for every request kind. Only the outgoing
// call is affected; persisted history stays raw.
export async function setup(ctx: Plugin.Context): Promise<Plugin.Cleanup> {
  const log: Logger = (level, message, extra) => {
    const line = `[veil] ${message}`
    if (level === "error") console.error(line, extra ?? "")
    else if (level === "warn") console.warn(line, extra ?? "")
    else console.info(line, extra ?? "")
  }

  const dbPath = veilDbPath()
  const db = openDb(dbPath)

  const binaryOk = await checkBinary()
  if (!binaryOk) {
    log("warn", "gitleaks binary not found; prompt-veil disabled (pass-through)")
  }

  const rpc = await registerVeil(ctx, db, binaryOk)

  const { scanEach } = createScanner({
    log,
    db,
    getParentID: async (sessionID) => {
      const info = await ctx.session.get({ sessionID })
      return info.parentID ?? null
    },
    onRedact: ({ rootID }) => {
      const redactions = countRedactions(db, rootID)
      void rpc.events.emit("scan", { sessionID: rootID, redactions }).catch(() => {})
    },
  })

  const redact = async (event: { sessionID: string; messages: Array<Message> }): Promise<void> => {
    if (!binaryOk) return
    await scanEach(collectTargets(event.messages, event.sessionID))
  }

  // Every model request kind shares the same transcript, so one handler covers
  // the agent loop and the auxiliary compaction, generate, and title requests.
  const registrations = await Promise.all([
    ctx.session.hook("context", redact),
    ctx.session.hook("compaction", redact),
    ctx.session.hook("generate", redact),
    ctx.session.hook("title", redact),
  ])

  const controller = new AbortController()
  const subscription = (async () => {
    for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
      if (event.type === "session.deleted") deleteSessionEvents(db, event.data.sessionID)
    }
  })().catch(() => {})

  return async () => {
    controller.abort()
    await subscription
    await rpc.dispose()
    for (const registration of registrations) await registration.dispose()
  }
}

export default { id: "veil", setup }
