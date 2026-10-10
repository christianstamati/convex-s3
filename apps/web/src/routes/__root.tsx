import { TanStackDevtools } from "@tanstack/react-devtools"
import type { QueryClient } from "@tanstack/react-query"
import { ReactQueryDevtoolsPanel } from "@tanstack/react-query-devtools"
import {
  createRootRouteWithContext,
  HeadContent,
  Scripts,
} from "@tanstack/react-router"
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools"
import { Toaster } from "@workspace/ui/components/sonner"
import appCss from "@workspace/ui/globals.css?url"
import type { ReactNode } from "react"
import { NotFound } from "@/components/layout/NotFound"
import { site } from "@/lib/site"

// Follow the OS color scheme. Runs before paint to avoid a flash.
const themeScript = `(() => {
  const media = matchMedia("(prefers-color-scheme: dark)")
  const apply = () => document.documentElement.classList.toggle("dark", media.matches)
  apply()
  media.addEventListener("change", apply)
})()`

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()(
  {
    head: () => ({
      meta: [
        { charSet: "utf-8" },
        { name: "viewport", content: "width=device-width, initial-scale=1" },
        { title: site.name },
        { name: "description", content: site.description },
      ],
      links: [
        { rel: "stylesheet", href: appCss },
        { rel: "icon", href: "/favicon.ico" },
        { rel: "manifest", href: "/manifest.json" },
      ],
      scripts: [{ children: themeScript }],
    }),
    shellComponent: RootDocument,
    notFoundComponent: NotFound,
  }
)

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body className="min-h-svh antialiased">
        {children}
        <Toaster richColors />
        <TanStackDevtools
          plugins={[
            { name: "Router", render: <TanStackRouterDevtoolsPanel /> },
            { name: "Query", render: <ReactQueryDevtoolsPanel /> },
          ]}
        />
        <Scripts />
      </body>
    </html>
  )
}
