import type { Message } from "@opencode/ai"
import type { ScanTarget } from "./scan"

// Minimal mutable views over the v2 message schema. The SDK types are readonly,
// but the hook hands us a mutable draft, so we cast once and write through.
type TextPart = { type: "text"; text: string }
type ContentEntry = { type: string; text?: string }
type ToolResult = { type: string; value: unknown }
type ToolResultPart = { type: "tool-result"; result: ToolResult }
type Part = TextPart | ToolResultPart | { type: string }

// Picks scannable spans out of a v2 model request: user text parts and tool
// results. Mirrors the v1 collector — user-authored text and tool output are the
// leak vectors; assistant text, reasoning, system, media, and tool inputs stay
// untouched. Redaction mutates the outgoing request only, never persisted history.
export function collectTargetsV2(messages: Array<Message>): ScanTarget[] {
  const out: ScanTarget[] = []
  messages.forEach((message, mi) => {
    const messageID = message.id ?? `message-${mi}`
    const content = message.content as unknown as Part[]
    content.forEach((part, pi) => {
      const partID = `${messageID}:${pi}`
      if (message.role === "user" && part.type === "text") {
        const text = part as TextPart
        push(out, { partID, messageID, kind: "text", get: () => text.text, set: (v) => { text.text = v } })
      } else if (part.type === "tool-result") {
        collectResult(out, partID, messageID, (part as ToolResultPart).result)
      }
    })
  })
  return out
}

function collectResult(
  out: ScanTarget[],
  partID: string,
  messageID: string,
  result: ToolResult,
): void {
  if (result.type === "content") {
    const entries = (result.value ?? []) as ContentEntry[]
    entries.forEach((entry, ei) => {
      if (entry.type !== "text" || typeof entry.text !== "string") return
      push(out, {
        partID: `${partID}:${ei}`,
        messageID,
        kind: "tool",
        get: () => entry.text as string,
        set: (v) => { entry.text = v },
      })
    })
    return
  }
  // text / error / json: scan every string leaf of the value.
  if (typeof result.value === "string") {
    push(out, {
      partID: `${partID}:0`,
      messageID,
      kind: "tool",
      get: () => result.value as string,
      set: (v) => { result.value = v },
    })
    return
  }
  let leaf = 0
  walkStrings(result.value, (get, set) =>
    push(out, { partID: `${partID}:${leaf++}`, messageID, kind: "tool", get, set }),
  )
}

function walkStrings(
  value: unknown,
  emit: (get: () => string, set: (v: string) => void) => void,
): void {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) walkSlot(value, i, emit)
  } else if (value && typeof value === "object") {
    for (const key of Object.keys(value)) walkSlot(value as Record<string, unknown>, key, emit)
  }
}

function walkSlot(
  container: unknown,
  key: string | number,
  emit: (get: () => string, set: (v: string) => void) => void,
): void {
  const record = container as Record<string | number, unknown>
  const value = record[key]
  if (typeof value === "string") {
    emit(() => record[key] as string, (v) => { record[key] = v })
  } else if (value && typeof value === "object") {
    walkStrings(value, emit)
  }
}

function push(out: ScanTarget[], target: ScanTarget): void {
  if (target.get().length > 0) out.push(target)
}
