import { IconFolderUp, IconUpload } from "@tabler/icons-react"
import { Button } from "@workspace/ui/components/button"
import { type ChangeEvent, useRef } from "react"
import { DriveBreadcrumbs } from "@/components/drive/DriveBreadcrumbs"
import { NewFolderDialog } from "@/components/drive/NewFolderDialog"
import { type FolderFile, pickedFiles } from "@/lib/droppedFiles"

/** Where you are, and the ways to add to it: a folder, files, a folder tree. */
export function DriveToolbar({
  path,
  onFiles,
}: {
  path: string
  onFiles: (items: FolderFile[]) => void
}) {
  const files = useRef<HTMLInputElement>(null)
  const folder = useRef<HTMLInputElement>(null)

  function handleFiles(event: ChangeEvent<HTMLInputElement>) {
    onFiles(
      Array.from(event.target.files ?? [], (file) => ({ file, folder: "" }))
    )
    event.target.value = ""
  }

  function handleFolder(event: ChangeEvent<HTMLInputElement>) {
    if (event.target.files) onFiles(pickedFiles(event.target.files))
    event.target.value = ""
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <DriveBreadcrumbs path={path} />
      <div className="flex flex-wrap gap-2">
        <input
          ref={files}
          type="file"
          multiple
          hidden
          onChange={handleFiles}
          aria-label="Files to upload"
        />
        <input
          ref={folder}
          type="file"
          hidden
          onChange={handleFolder}
          aria-label="Folder to upload"
          // Not in React's types: lets the input pick a whole folder.
          {...{ webkitdirectory: "" }}
        />
        <NewFolderDialog path={path} />
        <Button variant="outline" onClick={() => folder.current?.click()}>
          <IconFolderUp />
          Upload folder
        </Button>
        <Button onClick={() => files.current?.click()}>
          <IconUpload />
          Upload files
        </Button>
      </div>
    </div>
  )
}
