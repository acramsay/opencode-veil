# opencode-veil

[opencode](https://opencode.ai) plugin that redacts secrets before they reach the upstream LLM.
On each turn the `experimental.chat.messages.transform` hook hands plugins the full outgoing
message array. veil scans each user text part and each completed tool output once, memoized by
part ID per server process, and splices matches out as `[REDACTED:<rule-id>]`.

Tool outputs are the primary leak vector. `cat .env`, `gh auth token`, PEM files; much of what
the model sees arrives through completed tool parts, not typing. Tool inputs, error outputs, and
anything still pending or running stay untouched. Those states carry no output text to scrub yet,
and inputs are yours.

Assistant text parts are never scanned. They are the model's own prior output.

Nothing ever blocks a prompt. Any scanner error is logged and the text passes through unchanged.

Detection is fully local. [gitleaks](https://github.com/gitleaks/gitleaks) runs as
`gitleaks stdin`, no temp files, no network, ~25-35ms per span, no generative model involved. If
the binary is missing, the plugin disables itself and logs a warning to opencode.

## Install

Requires [gitleaks](https://github.com/gitleaks/gitleaks) on PATH (`brew install gitleaks` on
macOS).

Add the package to opencode.json:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-veil"]
}
```

opencode installs the package with Bun at startup.

## Audit

Every scan appends one JSON line to `~/.cache/veil/audit.jsonl`:

```json
{"ts":1788298584251,"outcome":"redact","kind":"tool","messageID":"msg_...","partID":"prt_...","scanMs":27,"rules":["github-pat"]}
```

`outcome` is `redact`, `clean`, or `fail-open`. `kind` is `text` or `tool`. The secret itself is
never logged, only rule IDs.

## Known behavior

- The transform mutates only the outgoing copy of a message. The stored session keeps the raw
  text, and part ID memoization means each span is scanned at most once per server process.
- Tool inputs, and tool outputs in `error`, `pending`, or `running` states, pass through
  unscrubbed.
- gitleaks' default ruleset deliberately allowlists example keys (`AKIA...EXAMPLE`) and
  entropy-filters low-variance strings. `fixtures.json` records shapes that reliably do and don't
  match.
- JWTs are redacted by gitleaks' `jwt` rule. They are secrets, not hard negatives.

## Development

```
bun install
bun run typecheck
bun run test
```

Tests run against the local gitleaks binary and skip with a hint when it is missing.
`fixtures.json` contains synthetic secrets that gitleaks must match, so GitHub may raise
secret-scanning alerts on this repo. Those are expected false positives.

MIT license.
