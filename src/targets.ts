import type { Message, Part } from "@opencode-ai/sdk"

export type ScanTarget = {
  partID: string
  messageID: string
  kind: "text" | "tool"
  get: () => string
  set: (v: string) => void
}

// Picks the scannable spans out of a transform message array: user text parts
// and completed tool outputs. Completed-only; error/running states carry no
// output text yet, and inputs stay untouched by design.
export function collectTargets(messages: Array<{ info: Message; parts: Part[] }>): ScanTarget[] {
  const out: ScanTarget[] = []
  for (const m of messages) {
    for (const p of m.parts) {
      if (m.info.role === "user" && p.type === "text" && !p.synthetic && !p.ignored) {
        out.push({ partID: p.id, messageID: m.info.id, kind: "text", get: () => p.text, set: (v) => { p.text = v } })
      } else if (m.info.role === "assistant" && p.type === "tool" && p.state.status === "completed") {
        const state = p.state
        out.push({ partID: p.id, messageID: m.info.id, kind: "tool", get: () => state.output, set: (v) => { if (state.status === "completed") state.output = v } })
      }
    }
  }
  return out
}
