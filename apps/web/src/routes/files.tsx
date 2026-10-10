import { createFileRoute } from "@tanstack/react-router"
import { FileList } from "@/components/files/FileList"
import { UploadCard } from "@/components/files/UploadCard"
import { AppShell } from "@/components/layout/AppShell"

export const Route = createFileRoute("/files")({
  head: () => ({ meta: [{ title: "Files" }] }),
  component: FilesPage,
})

function FilesPage() {
  return (
    <AppShell>
      <div className="flex flex-col gap-6">
        <UploadCard />
        <FileList />
      </div>
    </AppShell>
  )
}
