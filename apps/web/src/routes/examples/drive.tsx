import { createFileRoute } from "@tanstack/react-router"
import { DriveExplorer } from "@/components/drive/DriveExplorer"
import { ExampleHeader } from "@/components/examples/ExampleHeader"
import { AppShell } from "@/components/layout/AppShell"

export const Route = createFileRoute("/examples/drive")({
  // The open folder, relative to the Drive's root: "" or "Docs/2026/".
  validateSearch: (search): { path: string } => ({
    path: typeof search.path === "string" ? search.path : "",
  }),
  head: () => ({ meta: [{ title: "Drive" }] }),
  component: DrivePage,
})

function DrivePage() {
  const { path } = Route.useSearch()
  return (
    <AppShell>
      <div className="flex flex-col gap-6">
        <ExampleHeader slug="drive" />
        <DriveExplorer path={path} />
      </div>
    </AppShell>
  )
}
