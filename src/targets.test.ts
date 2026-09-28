import { describe, expect, test } from "bun:test"
import { collectTargets } from "./targets-v1"
import { collectTargetsV2 } from "./targets-v2"

const TOKEN = "ghp_YW7qKmnZpjUMSS1TvW2QAABBlvLsAGkDxyD4"

describe("collectTargets (v1)", () => {
  test("collects user text (incl. synthetic mention parts) + completed tool outputs, skips the rest", () => {
    const toolPart = {
      id: "tool-1",
      type: "tool" as const,
      state: { status: "completed" as const, output: `cat .env produced ${TOKEN}` },
    }
    const pendingTool = {
      id: "tool-2",
      type: "tool" as const,
      state: { status: "running" as const, output: TOKEN },
    }
    const textPart = { id: "u1", type: "text", text: `prefix ${TOKEN}` }
    // Synthetic text is how opencode injects @-mention file contents into the
    // user message; those parts are sent to the model, so they must scan.
    const syntheticPart = { id: "u2", type: "text", text: TOKEN, synthetic: true }
    const ignoredPart = { id: "u3", type: "text", text: TOKEN, ignored: true }
    const messages = [
      {
        info: { id: "msg-u", role: "user" },
        parts: [textPart, syntheticPart, ignoredPart, { id: "f1", type: "file", text: TOKEN }],
      },
      {
        info: { id: "msg-a", role: "assistant" },
        parts: [
          { id: "a1", type: "text", text: TOKEN },
          toolPart,
          pendingTool,
          { id: "t3", type: "tool", state: { status: "error", error: TOKEN, output: TOKEN } },
        ],
      },
      // Cast: minimal SDK stand-ins; collectTargets only reads the fields.
    ] as unknown as Parameters<typeof collectTargets>[0]
    const targets = collectTargets(messages)
    expect(targets.map((t) => t.partID).sort()).toEqual(["tool-1", "u1", "u2"])
    for (const t of targets) t.set("[REDACTED]")
    expect(textPart.text).toBe("[REDACTED]")
    expect(syntheticPart.text).toBe("[REDACTED]")
    expect(toolPart.state.output).toBe("[REDACTED]")
  })
})

describe("collectTargetsV2", () => {
  test("collects user text + tool results (incl. nested json strings), skips the rest", () => {
    const userText = { type: "text", text: `prefix ${TOKEN}` }
    const assistantText = { type: "text", text: TOKEN }
    const contentEntry = { type: "text", text: TOKEN }
    const fileEntry = { type: "file", uri: "file://secret", mime: "text/plain" }
    const contentResult = {
      type: "tool-result",
      id: "tr1",
      name: "read",
      result: { type: "content", value: [contentEntry, fileEntry] },
    }
    const jsonResult = {
      type: "tool-result",
      id: "tr2",
      name: "structured",
      result: { type: "json", value: { nested: { secret: TOKEN }, count: 3, arr: [TOKEN] } },
    }
    const textResult = {
      type: "tool-result",
      id: "tr3",
      name: "bash",
      result: { type: "text", value: TOKEN },
    }
    const messages = [
      { id: "m1", role: "user", content: [userText] },
      { id: "m2", role: "assistant", content: [assistantText] },
      { id: "m3", role: "tool", content: [contentResult] },
      { id: "m4", role: "tool", content: [jsonResult] },
      { id: "m5", role: "tool", content: [textResult] },
    ] as unknown as Parameters<typeof collectTargetsV2>[0]

    const targets = collectTargetsV2(messages)
    expect(targets.map((t) => t.partID).sort()).toEqual([
      "m1:0",
      "m3:0:0",
      "m4:0:0",
      "m4:0:1",
      "m5:0:0",
    ])
    for (const t of targets) t.set("[REDACTED]")
    expect(userText.text).toBe("[REDACTED]")
    expect(contentEntry.text).toBe("[REDACTED]")
    expect((jsonResult.result.value as { nested: { secret: string } }).nested.secret).toBe("[REDACTED]")
    expect((jsonResult.result.value as { arr: string[] }).arr[0]).toBe("[REDACTED]")
    expect(textResult.result.value).toBe("[REDACTED]")
    // assistant text and file entries are out of scope
    expect(assistantText.text).toBe(TOKEN)
    expect(fileEntry.uri).toBe("file://secret")
  })

  test("skips system-role text, media parts, and empty spans", () => {
    const messages = [
      { id: "s1", role: "system", content: [{ type: "text", text: TOKEN }] },
      {
        id: "u1",
        role: "user",
        content: [{ type: "media" }, { type: "text", text: "" }, { type: "text", text: TOKEN }],
      },
    ] as unknown as Parameters<typeof collectTargetsV2>[0]
    expect(collectTargetsV2(messages).map((t) => t.partID)).toEqual(["u1:2"])
  })

  test("redacts a bare-string error result", () => {
    const errResult = {
      type: "tool-result",
      id: "e1",
      name: "bash",
      result: { type: "error", value: `failed: ${TOKEN}` },
    }
    const messages = [{ id: "m1", role: "tool", content: [errResult] }] as unknown as Parameters<
      typeof collectTargetsV2
    >[0]
    const targets = collectTargetsV2(messages)
    expect(targets.map((t) => t.partID)).toEqual(["m1:0:0"])
    targets[0].set("[REDACTED]")
    expect(errResult.result.value).toBe("[REDACTED]")
  })

  test("falls back to an index-based message id when absent", () => {
    const messages = [{ role: "user", content: [{ type: "text", text: "hi" }] }] as unknown as Parameters<
      typeof collectTargetsV2
    >[0]
    expect(collectTargetsV2(messages)[0].messageID).toBe("message-0")
  })
})
