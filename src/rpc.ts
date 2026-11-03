import type { Database } from "bun:sqlite"
import type { Plugin } from "@opencode/plugin"
import { Rpc } from "@opencode/plugin/rpc"
import { z } from "zod"
import { countRedactions, type Stats } from "./store"

export const Veil = Rpc.define({
  id: "veil",
  methods: {
    stats: {
      input: z.object({ sessionID: z.string() }),
      output: z.object({ healthy: z.boolean(), redactions: z.number() }),
    },
  },
  events: {
    scan: { schema: z.object({ sessionID: z.string(), redactions: z.number() }) },
  },
})

export type ScanEvent = { sessionID: string; redactions: number }

export type VeilRpc = {
  events: { emit: (name: "scan", data: ScanEvent) => Promise<void> }
  dispose: () => Promise<void>
}

// Reads from the shared DB, not an instance's memory, so it stays correct no
// matter which per-location instance handles the call.
export function statsFor(db: Database, healthy: boolean, sessionID: string): Stats {
  return { healthy, redactions: countRedactions(db, sessionID) }
}

// `setup` runs once per location, and each location loads its own module
// instance, so this registers unconditionally. The host accepts the same id from
// several locations, and each location disposes only its own registration.
export function registerVeil(
  ctx: Plugin.Context,
  db: Database,
  healthy: boolean,
): Promise<VeilRpc> {
  return ctx.rpc.register(Veil, {
    stats: async ({ sessionID }) => statsFor(db, healthy, sessionID),
  })
}
