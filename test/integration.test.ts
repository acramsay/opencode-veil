import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

// End-to-end: spawns a real `opencode2 run --standalone` against a local
// OpenAI-compatible stub. No provider key and no network — the stub captures the
// outbound request body, which is exactly what veil redacts. We do not care what
// the model replies with, only that the secret never reaches the provider.
const SECRET = "ghp_YW7qKmnZpjUMSS1TvW2QAABBlvLsAGkDxyD4"
const BIN = process.env.VEIL_TEST_OPENCODE ?? "opencode2"
const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, "..")

const encoder = new TextEncoder()
const chunk = (delta: unknown, finish: string | null) =>
  `data: ${JSON.stringify({
    id: "c",
    object: "chat.completion.chunk",
    created: 0,
    model: "m",
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`

describe("veil through a real opencode v2 run", () => {
  if (!Bun.which(BIN)) {
    console.error(`${BIN} not on PATH — set VEIL_TEST_OPENCODE or install opencode v2 to run this suite`)
    test.skip("opencode v2 not installed", () => {})
    return
  }

  test.serial(
    "a prompt secret is redacted before the provider sees it",
    async () => {
      const captured: string[] = []
      const server = Bun.serve({
        port: 0,
        async fetch(req) {
          if (!new URL(req.url).pathname.endsWith("/chat/completions")) {
            return new Response("not found", { status: 404 })
          }
          const body = await req.text()
          captured.push(body)
          const parsed = body ? (JSON.parse(body) as { stream?: boolean }) : {}
          if (parsed.stream) {
            const stream = new ReadableStream({
              start(c) {
                c.enqueue(encoder.encode(chunk({ role: "assistant", content: "ok" }, null)))
                c.enqueue(encoder.encode(chunk({}, "stop")))
                c.enqueue(encoder.encode("data: [DONE]\n\n"))
                c.close()
              },
            })
            return new Response(stream, { headers: { "content-type": "text/event-stream" } })
          }
          return Response.json({
            id: "c",
            object: "chat.completion",
            created: 0,
            model: "m",
            choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          })
        },
      })

      try {
        // Isolated project: local plugin re-exports the repo's default entry, and
        // a custom provider points at the stub.
        const project = mkdtempSync(join(tmpdir(), "veil-it-"))
        const pluginDir = join(project, ".opencode", "plugins", "veil")
        mkdirSync(pluginDir, { recursive: true })
        writeFileSync(join(pluginDir, "index.ts"), `export { default } from ${JSON.stringify(join(repoRoot, "src", "plugin.ts"))}\n`)
        writeFileSync(
          join(project, "opencode.json"),
          JSON.stringify(
            {
              $schema: "https://opencode.ai/config.json",
              model: "mock/m",
              providers: {
                mock: {
                  name: "Mock",
                  package: "@opencode/ai/providers/openai-compatible",
                  settings: { baseURL: `http://127.0.0.1:${server.port}/v1`, apiKey: "test" },
                  models: { m: { name: "Mock" } },
                },
              },
            },
            null,
            2,
          ),
        )

        // Empty XDG dirs so the host's global config/plugins/accounts do not leak in.
        const home = mkdtempSync(join(tmpdir(), "veil-it-home-"))
        const proc = Bun.spawn([BIN, "run", "--standalone", "--auto", "-m", "mock/m", `please note this token: ${SECRET}`], {
          cwd: project,
          env: {
            ...process.env,
            XDG_CONFIG_HOME: join(home, "config"),
            XDG_CACHE_HOME: join(home, "cache"),
            XDG_DATA_HOME: join(home, "data"),
            XDG_STATE_HOME: join(home, "state"),
          },
          stdout: "pipe",
          stderr: "pipe",
        })

        const deadline = Date.now() + 60_000
        while (captured.length === 0 && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 100))
        }
        proc.kill()
        const stderr = await new Response(proc.stderr).text()

        expect(captured.length, `provider never received a request.\nstderr:\n${stderr}`).toBeGreaterThan(0)
        const wire = captured.join("\n")
        expect(wire).toContain("[REDACTED:github-pat]")
        expect(wire).not.toContain(SECRET)
      } finally {
        server.stop(true)
      }
    },
    90_000,
  )
})
