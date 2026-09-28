# opencode-veil

[opencode](https://opencode.ai) plugin that redacts secrets before they reach the upstream LLM.
On each turn opencode hands the plugin the full outgoing message array —
`experimental.chat.messages.transform` on v1, `ctx.session.hook("context", …)` on v2. veil
scans each user text part (including the synthetic parts opencode injects for `@`-mention file
references) and each completed tool output, and splices matches out as `[REDACTED:<rule-id>]`.
v1 and v2 are served from one package entrypoint; the redaction core is shared.

Tool outputs are the primary leak vector. `cat .env`, `gh auth token`, PEM files; much of what
the model sees arrives through completed tool parts, not typing. Tool inputs, error outputs, and
anything still pending or running stay untouched. Those states carry no output text to scrub yet,
and inputs are yours.

`@`-mentioning a file is an equally direct vector: opencode resolves the reference by injecting
the file's contents into the user message as synthetic text parts and sends them to the model.
Those parts are scanned like typed text. Only `ignored` parts (which never reach the model) are
skipped.

Assistant text parts are never scanned. They are the model's own prior output.

Nothing ever blocks a prompt. Any scanner error is logged and the text passes through unchanged.

Detection is fully local. [gitleaks](https://github.com/gitleaks/gitleaks) runs as
`gitleaks stdin`, no temp files, no network, ~25-35ms per span, no generative model involved. If
the binary is missing, the plugin disables itself and logs a warning to opencode.

## Install

Requires [gitleaks](https://github.com/gitleaks/gitleaks) on PATH (`brew install gitleaks` on
macOS).

Add the package to opencode.json. On v1 the key is `plugin`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@acramsay/opencode-veil"]
}
```

On v2 it is `plugins`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["@acramsay/opencode-veil"]
}
```

opencode installs the package with Bun at startup. On v2 the plugin registers the `context`,
`compaction`, `generate`, and `title` session hooks, so every model request kind is covered.

## Audit

Every scan appends one JSON line to `~/.cache/veil/audit.jsonl`:

```json
{"ts":1788298584251,"outcome":"redact","kind":"tool","messageID":"msg_...","partID":"prt_...","scanMs":27,"rules":["github-pat"]}
```

`outcome` is `redact`, `clean`, or `fail-open`. `kind` is `text` or `tool`. The secret itself is
never logged, only rule IDs.

## Known behavior

- Redaction mutates only the outgoing request. The stored session — and on v2, persisted
  history — keeps the raw text. This plugin does not rewrite history.
- Scan results are cached by content hash and re-applied on every model call, so a repeated
  span costs a hash lookup rather than another gitleaks run.
- On v2, assistant text, reasoning, system parts, media/file parts, and tool inputs pass
  through unscrubbed. Tool inputs are model-authored and redacting them would corrupt
  legitimate writes, so they stay untouched by design (matching v1).
- `@`-mention file injection is scanned, but the stored session still keeps the raw file text;
  redaction applies to the outgoing prompt only.
- v1: tool inputs, and tool outputs in `error`, `pending`, or `running` states, pass through
  unscrubbed.
- gitleaks' default ruleset deliberately allowlists example keys (`AKIA...EXAMPLE`) and
  entropy-filters low-variance strings. `fixtures.json` records shapes that reliably do and don't
  match.
- JWTs are redacted by gitleaks' `jwt` rule. They are secrets, not hard negatives.

## Development

```
bun install
bun run typecheck
bun run test              # unit: scanner, target collection, gitleaks fixtures
bun run test:integration  # spawns opencode2 against a local provider stub
```

Unit tests are co-located in `src/*.test.ts`. The gitleaks suite runs against the local binary and
skips with a hint when it is missing; the scanner and collector suites use injected fakes and need
nothing external. `fixtures.json` contains synthetic secrets that gitleaks must match, so GitHub
may raise secret-scanning alerts on this repo. Those are expected false positives.

Integration tests (`test/integration.test.ts`) spawn a real `opencode2 run --standalone` in a
throwaway project. A local OpenAI-compatible stub stands in for the provider, so there is no
provider key and no network: the test asserts the captured outbound request body contains the
redaction and never the raw secret. It is local/opt-in — CI runs unit tests only — and skips with
a hint when `opencode2` is not on PATH. Set `VEIL_TEST_OPENCODE` to use a different binary.

## Future work

- **Media/file content** is not scanned. v2 `media` content parts and `file` entries inside
  `tool-result` content can carry secrets (data URIs, referenced files). They pass through
  unscrubbed today.
- **Assistant text and reasoning** are trusted as model output and not scanned. They can only
  carry a secret that leaked through some other vector.

## Releases

Trunk-based: work merges to `main` and semantic-release runs in CI on every push to `main`.
Conventional commits drive the bumps (`feat` minor, `fix` patch, breaking changes major); each
release publishes to npm, updates `package.json` and `CHANGELOG.md`, and creates a GitHub release.
Never push a `v*` tag by hand, and never publish from a local machine.

MIT license.
