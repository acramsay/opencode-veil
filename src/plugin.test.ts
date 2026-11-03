import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { checkBinary } from "./gitleaks"
import plugin from "./plugin"

const TOKEN = "ghp_YW7qKmnZpjUMSS1TvW2QAABBlvLsAGkDxyD4"
const BINARY = process.env.VEIL_TEST_BINARY ?? "gitleaks"
const binaryOk = await checkBinary(BINARY)

// Isolate redaction writes; veil resolves the cache dir at call time.
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
  test("exposes the plugin id and setup", () => {
    expect(plugin.id).toBe("veil")
    expect(typeof plugin.setup).toBe("function")
  })
})

describe("setup", () => {
  const makeCtx = () => {
    const names: string[] = []
    const handlers: Record<string, (event: unknown) => unknown> = {}
    const disposed: string[] = []
    const emitted: Array<{ name: string; data: unknown }> = []
    let rpcDisposed = false
    const ctx = {
      rpc: {
        register: async () => ({
          events: {
            emit: async (name: string, data: unknown) => {
              emitted.push({ name, data })
            },
          },
          dispose: async () => {
            rpcDisposed = true
          },
        }),
      },
      session: {
        hook: async (name: string, cb: (event: unknown) => unknown) => {
          names.push(name)
          handlers[name] = cb
          return { dispose: async () => { disposed.push(name) } }
        },
        get: async () => ({ parentID: undefined }),
      },
      event: {
        subscribe: () => ({
          async *[Symbol.asyncIterator]() {
            // no events in tests
          },
        }),
      },
    }
    return { ctx, names, handlers, disposed, emitted, rpcDisposed: () => rpcDisposed }
  }

  test("registers every model-request kind and disposes them on cleanup", async () => {
    await withTempCache(async () => {
      const { ctx, names, disposed, rpcDisposed } = makeCtx()
      const cleanup = await plugin.setup(ctx as never)
      expect([...names].sort()).toEqual(["compaction", "context", "generate", "title"])
      await cleanup()
      expect([...disposed].sort()).toEqual(["compaction", "context", "generate", "title"])
      expect(rpcDisposed()).toBe(true)
    })
  })

  if (!binaryOk) {
    test.skip("context handler redacts (SKIPPED: gitleaks not on PATH)", () => {})
  } else {
    test("context handler redacts user text and tool results", async () => {
      await withTempCache(async () => {
        const { ctx, handlers, emitted } = makeCtx()
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
        await handlers.context({ sessionID: "s1", messages, system: [], options: {} })
        expect(userText.text).toBe("ask [REDACTED:github-pat]")
        expect(toolResult.result.value).toBe("out [REDACTED:github-pat]")
        expect(emitted).toEqual([
          { name: "scan", data: { sessionID: "s1", redactions: 1 } },
          { name: "scan", data: { sessionID: "s1", redactions: 2 } },
        ])
      })
    })
  }
})
