import type { Plugin } from "@opencode/plugin/tui"
import tui from "../tui"

// Development entrypoint. The published package registers as `veil-tui`; a
// source checkout registers as `veil-tui-dev` so it can load alongside the
// published TUI part without an ID collision.
const dev: Plugin.Definition = { ...tui, id: "veil-tui-dev" }

export default dev
