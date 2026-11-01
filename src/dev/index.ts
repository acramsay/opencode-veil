import plugin from "../plugin"

// Development entrypoint. The published package registers as `veil`; a source
// checkout registers as `veil-dev` so it can be configured alongside the
// published plugin without a duplicate-plugin-ID collision.
export default { ...plugin, id: "veil-dev" }
