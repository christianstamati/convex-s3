import { defineApp } from "convex/server"

// Deployment env vars, validated on every push, go in `defineApp({ env })`.
// Set them with `bunx convex env set` in packages/backend (see README.md).
const app = defineApp()

export default app
