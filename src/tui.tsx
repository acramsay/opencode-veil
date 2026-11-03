// The published `./tui` entry is a precompiled copy of this file (see
// scripts/build-tui.ts), a temporary workaround for anomalyco/opencode#39986.
// This raw TSX stays the source of truth and the dev fallback.
import { Plugin } from "@opencode/plugin/tui"
import type { RGBA } from "@opentui/core"
import { createEffect, createSignal, onCleanup } from "solid-js"
import { Veil } from "./rpc"
import type { Stats } from "./store"

export default Plugin.define({
  id: "veil-tui",
  setup(context) {
    const rpc = context.client.rpc(Veil)

    const Sidebar = (props: { sessionID: string }) => {
      const [stats, setStats] = createSignal<Stats | null>(null)
      const [failed, setFailed] = createSignal(false)

      // The sidebar can outlive its session during teardown, so a missing root
      // reads as no data instead of throwing.
      const rootID = (): string | null => {
        try {
          return context.data.session.root(props.sessionID)
        } catch {
          return null
        }
      }

      // The RPC route resolves to the server's default location unless the call
      // names one, so a project-local install would otherwise miss its own
      // registration. Prefer the session's location; fall back to the TUI's.
      const location = () =>
        context.data.session.get(props.sessionID)?.location ?? context.location

      const refresh = async () => {
        const root = rootID()
        if (root === null) return
        try {
          setStats(await rpc.stats({ sessionID: root }, { location: location() }))
          setFailed(false)
        } catch {
          setFailed(true)
        }
      }

      createEffect(() => {
        void refresh()
      })

      const unsubscribe = rpc.events.on("scan", (event) => {
        if (event.data.sessionID !== rootID()) return
        setStats((prev) => ({ healthy: prev?.healthy ?? false, redactions: event.data.redactions }))
        setFailed(false)
      })
      onCleanup(unsubscribe)

      const healthColor = (): RGBA =>
        !failed() && stats()?.healthy === true
          ? context.theme.text.feedback.success.base
          : context.theme.text.feedback.error.base

      const redactions = () => stats()?.redactions ?? 0

      // @opentui/solid reads span colors from style.fg (a bare fg prop is
      // ignored), and its SpanProps type omits the field.
      return (
        <box flexDirection="row" justifyContent="space-between" width="100%">
          <text>
            <span {...{ style: { fg: context.theme.text.base } }}>Veil </span>
            <span {...{ style: { fg: healthColor() } }}>●</span>
          </text>
          <text style={{ fg: context.theme.text.base }}>{`${redactions()} 🔍`}</text>
        </box>
      )
    }

    context.ui.slot({
      append: "sidebar.content",
      render: ({ sessionID }) => <Sidebar sessionID={sessionID} />,
    })
  },
})
