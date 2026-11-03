import { describe, expect, test } from "bun:test"
import { collectTargets } from "./targets"

const TOKEN = "ghp_YW7qKmnZpjUMSS1TvW2QAABBlvLsAGkDxyD4"

describe("collectTargets", () => {
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
    ] as unknown as Parameters<typeof collectTargets>[0]

    const targets = collectTargets(messages, "s1")
    expect(targets.map((t) => t.partID).sort()).toEqual([
      "m1:0",
      "m3:0:0",
      "m4:0:0",
      "m4:0:1",
      "m5:0:0",
    ])
    expect(targets.every((t) => t.sessionID === "s1")).toBe(true)
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
    ] as unknown as Parameters<typeof collectTargets>[0]
    expect(collectTargets(messages, "s1").map((t) => t.partID)).toEqual(["u1:2"])
  })

  test("redacts a bare-string error result", () => {
    const errResult = {
      type: "tool-result",
      id: "e1",
      name: "bash",
      result: { type: "error", value: `failed: ${TOKEN}` },
    }
    const messages = [{ id: "m1", role: "tool", content: [errResult] }] as unknown as Parameters<
      typeof collectTargets
    >[0]
    const targets = collectTargets(messages, "s1")
    expect(targets.map((t) => t.partID)).toEqual(["m1:0:0"])
    targets[0].set("[REDACTED]")
    expect(errResult.result.value).toBe("[REDACTED]")
  })

  test("falls back to an index-based message id when absent", () => {
    const messages = [{ role: "user", content: [{ type: "text", text: "hi" }] }] as unknown as Parameters<
      typeof collectTargets
    >[0]
    expect(collectTargets(messages, "s1")[0].messageID).toBe("message-0")
  })
})
