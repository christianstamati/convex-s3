import { convexQuery } from "@convex-dev/react-query"
import { IconFolderOpen } from "@tabler/icons-react"
import { keepPreviousData, useQuery } from "@tanstack/react-query"
import { api } from "@workspace/backend/api"
import { Card, CardContent } from "@workspace/ui/components/card"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@workspace/ui/components/empty"
import { DriveFileRow } from "@/components/drive/DriveFileRow"
import { DriveFolderRow } from "@/components/drive/DriveFolderRow"

/**
 * The open folder's subfolders, then its files. Live: what anyone uploads,
 * moves or deletes shows up at once. The previous folder stays on screen
 * while the next one loads.
 */
export function DriveTable({ path }: { path: string }) {
  const { data, isPending } = useQuery({
    ...convexQuery(api.drive.list, { path }),
    placeholderData: keepPreviousData,
  })

  if (isPending || !data) {
    return (
      <p className="py-10 text-center text-muted-foreground text-sm">
        Loading…
      </p>
    )
  }

  const empty = data.folders.length === 0 && data.files.length === 0
  return (
    <Card>
      <CardContent>
        {empty ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <IconFolderOpen />
              </EmptyMedia>
              <EmptyTitle>This folder is empty</EmptyTitle>
              <EmptyDescription>
                Drop files or folders here, or use the buttons above.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="flex flex-col">
            <div className="flex items-center gap-3 border-b pb-2 text-muted-foreground text-xs">
              <span className="flex-1">Name</span>
              <span className="hidden w-20 text-right sm:block">Size</span>
              <span className="hidden w-28 sm:block">Modified</span>
              <span className="w-8" />
            </div>
            <ul className="flex flex-col divide-y">
              {data.folders.map((folder) => (
                <DriveFolderRow key={folder.path} folder={folder} />
              ))}
              {data.files.map((file) => (
                <DriveFileRow key={file.key} file={file} />
              ))}
            </ul>
            {data.isTruncated && (
              <p className="pt-2 text-muted-foreground text-xs">
                Showing the first 1,000 items.
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
