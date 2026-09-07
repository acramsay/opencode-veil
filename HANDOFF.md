# Handoff: opencode-veil

Written 2026-09-07 at the end of a session in the owner's dotfiles repo
(`/Users/alexramsay/git/dotfiles`). This repo was created to turn a working, vendored opencode
plugin into a published npm package that opencode loads by name from the registry. It is seeded
with this document, an MIT LICENSE, and a README stub; everything else is Phase 1 below. You are
starting with an empty codebase and a finished reference implementation that lives in the
dotfiles repo.

## What veil does

veil redacts secrets before they reach the upstream LLM. It hooks
`experimental.chat.messages.transform`, scans user text parts and completed tool outputs by
spawning `gitleaks stdin` (fully local, no network), and splices matches out as
`[REDACTED:<rule-id>]`. It fails open: a scanner error is logged and the text passes through
untouched. Part IDs are memoized so each span is scanned at most once per server process. Every
scan appends a JSON line to `~/.cache/veil/audit.jsonl` — rule IDs only, never the secret.

Behavior is already documented in the source README. Read it first and adapt it for this repo:
`/Users/alexramsay/git/dotfiles/home/.config/opencode/plugins/veil/README.md`

## Source of truth

Port the existing implementation from the dotfiles repo; treat it as the reference and preserve
its semantics. All files live under
`/Users/alexramsay/git/dotfiles/home/.config/opencode/plugins/veil/`:

- `plugin.ts` — transform hook, scan gating, audit glue
- `lib.ts` — gitleaks spawning, finding parsing, redaction splicing, target collection, audit
  writer
- `fixtures.json` — synthetic-secret fixtures with expected rule IDs plus hard negatives
- `test.ts` — `bun test` suite, no opencode server required
- `README.md` — adapt into this repo's README

Dependency surface: `@opencode-ai/plugin` and `@opencode-ai/sdk` are type-only imports; there
are zero runtime npm dependencies. The code uses Bun APIs (`Bun.spawn`), which is safe —
opencode runs plugins under Bun. External runtime dependency: the `gitleaks` binary on PATH; the
plugin disables itself gracefully when it is missing.

## Decisions already made

These came out of the upstream session — treat them as settled constraints.

- Package name: `opencode-veil`, unscoped. Verified free on npm; the name `veil` is taken, so
  keep the `opencode-` prefix.
- Repository: `github.com/acramsay/opencode-veil`, public, under the personal `acramsay`
  account. Keep this project under the personal account — it is deliberately independent of any
  org (liatrio, liatrio-labs, or others).
- License: MIT, copyright "Alex Ramsay", 2026. The LICENSE file is already committed.
- Publishing runs in CI only. Never run `npm publish` from a local machine; the owner's local
  npm login is for verification commands (`npm whoami`, `npm view`), never for publishing.

## Phase 1 — build the package here

Work through these in order:

1. **Verify the plugin loading contract.** opencode.json's `"plugin"` array accepts npm package
   names. Confirm against opencode's docs and source how the package is resolved and which
   export is invoked. Two working precedents to inspect: `npm view opencode-pty` and
   `npm view @tarquinen/opencode-dcp` — both ship built JS in `dist/` with an `exports` map.
   Bun loads TypeScript natively, so shipping the TS entry directly may also work; confirm
   before choosing and prefer whichever option is simpler.
2. **Scaffold.** `package.json` (name `opencode-veil`, version 0.1.0, `exports` per the
   verified contract, type-only deps on `@opencode-ai/plugin` + `@opencode-ai/sdk`), tsconfig,
   and a build step only if the contract requires compiled JS.
3. **Port the five files** listed above. Keep code, fixtures, and tests byte-identical where
   possible; adjust import paths as needed.
4. **CI.** GitHub Actions workflow: install Bun, install gitleaks on the runner, run
   `bun test`, and on tag push publish with an `NPM_TOKEN` secret. Note the first-publish token
   nuance: npm granular access tokens are scoped to packages that already exist, so the initial
   0.1.0 publish needs either a classic automation token or a broader granular token, rotating
   to a package-scoped granular token afterward. Surface the token choice to the owner — the
   tradeoff is theirs to make.
5. **Handle secret-scanning alerts.** `fixtures.json` intentionally contains structurally-valid
   synthetic secrets (gitleaks must match them). GitHub secret scanning may raise alerts on
   this public repo; resolve them as false positives and add the fixture paths to the ignore
   list.
6. **Publish 0.1.0 from CI, then verify end-to-end.** Add `"opencode-veil"` to a scratch
   opencode config's `"plugin"` array and confirm the plugin loads and redacts a known
   synthetic secret.

## Phase 2 — dotfiles follow-up (out of scope here)

Once the package works from the registry, the dotfiles repo replaces its local shims
(`home/.config/opencode/plugins/veil.ts` and the vendored `veil/` directory) with the npm entry
in `home/.config/opencode/opencode.json`. That work happens in a session in the dotfiles repo.

## Suggested skills

- `code-review` — before the first publish, review the port against the dotfiles original.
- `handoff` — when this phase completes or needs to move again.
- `unslop` — applies to any prose you write (README, workflow files, commit messages).
