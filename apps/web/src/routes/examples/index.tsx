import { createFileRoute } from "@tanstack/react-router"
import { ExampleGrid } from "@/components/examples/ExampleGrid"
import { AppShell } from "@/components/layout/AppShell"

export const Route = createFileRoute("/examples/")({
  head: () => ({ meta: [{ title: "Examples" }] }),
  component: ExamplesPage,
})

function ExamplesPage() {
  return (
    <AppShell>
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-1">
          <h1 className="font-heading font-semibold text-2xl tracking-tight">
            Examples
          </h1>
          <p className="text-muted-foreground text-sm">
            Each one runs on the same component and bucket.
          </p>
        </div>
        <ExampleGrid />
      </div>
    </AppShell>
  )
}
