import { api } from "@workspace/backend/api"
import { Button } from "@workspace/ui/components/button"
import { Card, CardContent } from "@workspace/ui/components/card"
import { type DragEvent, useState } from "react"
import { DriveTable } from "@/components/drive/DriveTable"
import { DriveToolbar } from "@/components/drive/DriveToolbar"
import { UploadRow } from "@/components/uploads/UploadRow"
import { droppedFiles, type FolderFile } from "@/lib/droppedFiles"
import { useUploadQueue } from "@/lib/useUploadQueue"

/**
 * One open folder of the Drive: its toolbar, its contents, and the uploads
 * going into it. Files and whole folders can be dropped anywhere on it.
 */
export function DriveExplorer({ path }: { path: string }) {
  const { uploads, start, clearFinished } = useUploadQueue(api.drive)
  const [dragging, setDragging] = useState(false)

  const upload = (items: FolderFile[]) => {
    for (const { file, folder } of items) start(file, path + folder)
  }

  function handleDragOver(event: DragEvent) {
    if (!event.dataTransfer.types.includes("Files")) return
    event.preventDefault()
    setDragging(true)
  }

  function handleDragLeave(event: DragEvent<HTMLDivElement>) {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setDragging(false)
    }
  }

  async function handleDrop(event: DragEvent) {
    event.preventDefault()
    setDragging(false)
    upload(await droppedFiles(event.dataTransfer))
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a drop zone; the toolbar's buttons do the same from the keyboard
    <div
      data-dragging={dragging}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className="flex flex-col gap-4 rounded-xl outline-dashed outline-2 outline-transparent outline-offset-4 data-[dragging=true]:outline-primary"
    >
      <DriveToolbar path={path} onFiles={upload} />
      {uploads.length > 0 && (
        <Card>
          <CardContent className="flex flex-col gap-2">
            <ul className="flex flex-col divide-y">
              {uploads.map((item) => (
                <UploadRow key={item.id} upload={item} />
              ))}
            </ul>
            {uploads.some((item) => item.status !== "uploading") && (
              <Button
                variant="ghost"
                size="sm"
                className="self-end"
                onClick={clearFinished}
              >
                Clear finished
              </Button>
            )}
          </CardContent>
        </Card>
      )}
      <DriveTable path={path} />
    </div>
  )
}
