import { createFileRoute } from "@tanstack/react-router"
import { ExampleHeader } from "@/components/examples/ExampleHeader"
import { FileList } from "@/components/files/FileList"
import { UploadCard } from "@/components/files/UploadCard"
import { AppShell } from "@/components/layout/AppShell"

export const Route = createFileRoute("/examples/uploads")({
  head: () => ({ meta: [{ title: "Uploads" }] }),
  component: UploadsPage,
})

function UploadsPage() {
  return (
    <AppShell>
      <div className="flex flex-col gap-6">
        <ExampleHeader slug="uploads" />
        <UploadCard />
        <FileList />
      </div>
    </AppShell>
  )
}
