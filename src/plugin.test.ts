import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { checkBinary } from "./gitleaks"
import plugin from "./plugin"

const TOKEN = "ghp_YW7qKmnZpjUMSS1TvW2QAABBlvLsAGkDxyD4"
const BINARY = process.env.VEIL_TEST_BINARY ?? "gitleaks"
const binaryOk = await checkBinary(BINARY)

// Isolate audit writes; veil resolves the cache dir at call time.
const withTempCache = async <T>(fn: () => Promise<T>): Promise<T> => {
  const prev = process.env.XDG_CACHE_HOME
  process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "veil-plugin-"))
  try {
    return await fn()
  } finally {
    if (prev === undefined) delete process.env.XDG_CACHE_HOME
    else process.env.XDG_CACHE_HOME = prev
  }
}

describe("entry", () => {
  test("exposes the dual-support shape shared by v1 and v2", () => {
    expect(plugin.id).toBe("veil")
    expect(typeof plugin.setup).toBe("function")
    expect(typeof plugin.server).toBe("function")
  })
})

describe("v2 setup", () => {
  const makeCtx = () => {
    const names: string[] = []
    const handlers: Record<string, (event: unknown) => unknown> = {}
    const disposed: string[] = []
    const ctx = {
      session: {
        hook: async (name: string, cb: (event: unknown) => unknown) => {
          names.push(name)
          handlers[name] = cb
          return { dispose: async () => { disposed.push(name) } }
        },
      },
    }
    return { ctx, names, handlers, disposed }
  }

  test("registers every model-request kind and disposes them on cleanup", async () => {
    await withTempCache(async () => {
      const { ctx, names, disposed } = makeCtx()
      const cleanup = await plugin.setup(ctx as never)
      expect([...names].sort()).toEqual(["compaction", "context", "generate", "title"])
      await cleanup()
      expect([...disposed].sort()).toEqual(["compaction", "context", "generate", "title"])
    })
  })

  if (!binaryOk) {
    test.skip("context handler redacts (SKIPPED: gitleaks not on PATH)", () => {})
  } else {
    test("context handler redacts user text and tool results", async () => {
      await withTempCache(async () => {
        const { ctx, handlers } = makeCtx()
        await plugin.setup(ctx as never)
        const userText = { type: "text", text: `ask ${TOKEN}` }
        const toolResult = {
          type: "tool-result",
          id: "tr",
          name: "bash",
          result: { type: "text", value: `out ${TOKEN}` },
        }
        const messages = [
          { id: "m1", role: "user", content: [userText] },
          { id: "m2", role: "tool", content: [toolResult] },
        ]
        await handlers.context({ messages, system: [], options: {} })
        expect(userText.text).toBe("ask [REDACTED:github-pat]")
        expect(toolResult.result.value).toBe("out [REDACTED:github-pat]")
      })
    })
  }
})

describe("v1 server", () => {
  const makeCtx = () => ({
    client: { app: { log: async () => ({}) } },
    directory: "/tmp",
  })

  if (!binaryOk) {
    test.skip("transform hook redacts (SKIPPED: gitleaks not on PATH)", () => {})
  } else {
    test("transform hook redacts user text and completed tool output", async () => {
      await withTempCache(async () => {
        const hooks = await plugin.server(makeCtx() as never)
        const toolPart = { id: "p1", type: "tool", state: { status: "completed", output: `x ${TOKEN}` } }
        const output = {
          messages: [
            { info: { id: "mu", role: "user" }, parts: [{ id: "u1", type: "text", text: `hi ${TOKEN}` }] },
            { info: { id: "ma", role: "assistant" }, parts: [toolPart] },
          ],
        }
        await (hooks as { "experimental.chat.messages.transform": Function })[
          "experimental.chat.messages.transform"
        ]({}, output)
        expect((output.messages[0].parts[0] as { text: string }).text).toBe("hi [REDACTED:github-pat]")
        expect(toolPart.state.output).toBe("x [REDACTED:github-pat]")
      })
    })
  }
})
