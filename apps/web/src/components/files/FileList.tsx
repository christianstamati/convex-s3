import { convexQuery } from "@convex-dev/react-query"
import { IconFiles } from "@tabler/icons-react"
import { useSuspenseQuery } from "@tanstack/react-query"
import { api } from "@workspace/backend/api"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@workspace/ui/components/card"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@workspace/ui/components/empty"
import { FileItem } from "@/components/files/FileItem"

/** The uploaded files, newest first. Live: new uploads appear on their own. */
export function FileList() {
  const { data: files } = useSuspenseQuery(convexQuery(api.files.list, {}))

  return (
    <Card>
      <CardHeader>
        <CardTitle>Files</CardTitle>
        <CardDescription>
          Stored in S3; download links are presigned and last an hour.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {files.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <IconFiles />
              </EmptyMedia>
              <EmptyTitle>No files yet</EmptyTitle>
              <EmptyDescription>
                Upload one above. It shows up here in every open tab.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ul className="flex flex-col divide-y">
            {files.map((file) => (
              <FileItem key={file._id} file={file} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
