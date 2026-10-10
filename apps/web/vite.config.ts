import { fileURLToPath } from "node:url"
import tailwindcss from "@tailwindcss/vite"
import { devtools } from "@tanstack/devtools-vite"
import { tanstackStart } from "@tanstack/react-start/plugin/vite"
import viteReact from "@vitejs/plugin-react"
import { nitro } from "nitro/vite"
import { defineConfig, loadEnv } from "vite"

const backendDir = fileURLToPath(
  new URL("../../packages/backend", import.meta.url)
)

export default defineConfig(({ mode }) => {
  // `convex dev` writes VITE_CONVEX_URL and VITE_CONVEX_SITE_URL to
  // packages/backend/.env.local. Reuse them so there is one source of truth.
  // On Vercel, `convex deploy` injects VITE_CONVEX_URL, which takes precedence.
  const convexEnv = loadEnv(mode, backendDir, "VITE_CONVEX_")
  for (const [key, value] of Object.entries(convexEnv)) {
    process.env[key] ??= value
  }

  return {
    // Stay on localhost:3000: fail instead of silently moving to another
    // port.
    server: { port: 3000, strictPort: true },
    resolve: { tsconfigPaths: true },
    plugins: [
      devtools(),
      tailwindcss(),
      tanstackStart(),
      // Builds for Vercel automatically when deployed there, Node otherwise.
      nitro({
        rolldownConfig: {
          onwarn(warning, warn) {
            // Libraries ship "use client" directives for RSC; harmless here.
            if (warning.code !== "MODULE_LEVEL_DIRECTIVE") warn(warning)
          },
        },
      }),
      viteReact(),
    ],
  }
})
