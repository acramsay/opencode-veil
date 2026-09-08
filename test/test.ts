import { describe, expect, test } from "bun:test"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { checkBinary, redactText, scanText, type Finding } from "../src/gitleaks"
import { collectTargets } from "../src/targets"

// Prompt redaction via the local gitleaks binary — no opencode server needed.
// Skip all with a hint if gitleaks is missing, mirroring the shield-bash
// binary-check pattern.
const BINARY = process.env.VEIL_TEST_BINARY ?? "gitleaks"
const LATENCY_BUDGET_P95_MS = 500 // stdin spawn measured ~15ms cold

type Fixture = { name: string; text: string; expect: string[] }
const here = dirname(fileURLToPath(import.meta.url))
const fixtures = (await Bun.file(join(here, "fixtures.json")).json()) as Fixture[]

const binaryOk = await checkBinary(BINARY)

describe("veil gitleaks pipeline", () => {
  describe("target collection", () => {
    test("collects user text + completed tool outputs, skips the rest", () => {
      const token = "ghp_YW7qKmnZpjUMSS1TvW2QAABBlvLsAGkDxyD4"
      const toolPart = {
        id: "tool-1",
        type: "tool" as const,
        state: { status: "completed" as const, output: `cat .env produced ${token}` },
      }
      const pendingTool = {
        id: "tool-2",
        type: "tool" as const,
        state: { status: "running" as const, output: token },
      }
      const textPart = { id: "u1", type: "text", text: `prefix ${token}` }
      const messages = [
        {
          info: { id: "msg-u", role: "user" },
          parts: [
            textPart,
            { id: "u2", type: "text", text: token, synthetic: true },
            { id: "f1", type: "file", text: token },
          ],
        },
        {
          info: { id: "msg-a", role: "assistant" },
          parts: [
            { id: "a1", type: "text", text: token },
            toolPart,
            pendingTool,
            { id: "t3", type: "tool", state: { status: "error", error: token, output: token } },
          ],
        },
      // Cast: minimal SDK stand-ins; collectTargets only reads the fields.
      ] as unknown as Parameters<typeof collectTargets>[0]
      const targets = collectTargets(messages)
      expect(targets.map((t) => t.partID).sort()).toEqual(["tool-1", "u1"])
      for (const t of targets) {
        t.set("[REDACTED]")
      }
      expect(textPart.text).toBe("[REDACTED]")
      expect(toolPart.state.output).toBe("[REDACTED]")
    })
  })

  describe("fixtures", () => {
    for (const fx of fixtures) {
      if (!binaryOk) {
        test.skip(`redact ${fx.name} (SKIPPED: gitleaks not on PATH — brew install gitleaks)`, () => {})
        continue
      }
      test(`redact ${fx.name}`, async () => {
        const findings: Finding[] = await scanText(fx.text, BINARY)
        const rules = [...new Set(findings.map((f) => f.rule))]
        expect(rules.sort()).toEqual([...fx.expect].sort())
        const redacted = redactText(fx.text, findings)
        for (const f of findings) {
          expect(redacted).toContain(`[REDACTED:${f.rule}]`)
          expect(redacted).not.toContain(f.match)
        }
      })
    }
  })

  describe("latency", () => {
    if (!binaryOk) {
      test.skip("p95 under budget (SKIPPED: gitleaks not on PATH)", () => {})
    } else {
      test("p95 under budget across fixtures", async () => {
        const timings: number[] = []
        // Longest first to exercise worst-case text sizes.
        const ordered = [...fixtures].sort((a, b) => b.text.length - a.text.length)
        for (const fx of ordered) {
          const start = Date.now()
          await scanText(fx.text, BINARY)
          timings.push(Date.now() - start)
        }
        timings.sort((a, b) => a - b)
        const p95 = timings[Math.max(0, Math.ceil(timings.length * 0.95) - 1)]
        expect(p95).toBeLessThan(LATENCY_BUDGET_P95_MS)
      })
    }
  })
})
