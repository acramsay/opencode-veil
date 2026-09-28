import { server } from "./v1"
import { setup } from "./v2"

// Shared entrypoint for both hosts. V1 calls `server()`; V2 reads `id` and calls
// `setup()`, ignoring `server`. Mirrors the dual-support shape in the v2
// migration guide, with no runtime dependency on either plugin package.
export default { id: "veil", setup, server }
