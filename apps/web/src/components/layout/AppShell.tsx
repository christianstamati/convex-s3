import type { ReactNode } from "react"
import { AppHeader } from "@/components/layout/AppHeader"

/** The layout of app pages: the header and a centered content column. */
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-svh flex-col">
      <AppHeader />
      <main className="mx-auto w-full max-w-3xl flex-1 p-6">{children}</main>
    </div>
  )
}
