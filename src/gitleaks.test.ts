import { describe, expect, test } from "bun:test"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { checkBinary, redactText, scanText, type Finding } from "./gitleaks"

// Exercises the local gitleaks binary — no opencode server needed. Skips with a
// hint when gitleaks is missing, mirroring the shield-bash binary-check pattern.
const BINARY = process.env.VEIL_TEST_BINARY ?? "gitleaks"
const LATENCY_BUDGET_P95_MS = 500 // stdin spawn measured ~15ms cold

type Fixture = { name: string; text: string; expect: string[] }
const here = dirname(fileURLToPath(import.meta.url))
const fixtures = (await Bun.file(join(here, "..", "test", "fixtures.json")).json()) as Fixture[]

const binaryOk = await checkBinary(BINARY)

describe("gitleaks pipeline", () => {
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
