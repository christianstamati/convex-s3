import { IconUpload } from "@tabler/icons-react"
import { api } from "@workspace/backend/api"
import { Button } from "@workspace/ui/components/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@workspace/ui/components/card"
import { type ChangeEvent, useRef } from "react"
import { UploadRow } from "@/components/uploads/UploadRow"
import { useUploadQueue } from "@/lib/useUploadQueue"

const MiB = 1024 * 1024

/** A file of `size` bytes, to try a multipart upload without picking one. */
function testFile(size: number) {
  const bytes = new Uint8Array(size)
  for (let i = 0; i < size; i++) bytes[i] = i % 251
  return new File([bytes], `test-${size / MiB}mb.bin`, {
    type: "application/octet-stream",
  })
}

/**
 * Picks files and uploads each one straight to S3, with progress and a way
 * to cancel. Files over 8 MB go up in parts.
 */
export function UploadCard() {
  const { uploads, start } = useUploadQueue(api.files)
  const input = useRef<HTMLInputElement>(null)

  function handleFiles(event: ChangeEvent<HTMLInputElement>) {
    for (const file of Array.from(event.target.files ?? [])) start(file)
    event.target.value = ""
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Upload</CardTitle>
        <CardDescription>
          Files go from your browser straight to S3. Over 8 MB they go up in 5
          MB parts, four at a time.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap gap-2">
          <input
            ref={input}
            type="file"
            multiple
            hidden
            onChange={handleFiles}
            aria-label="Files to upload"
          />
          <Button onClick={() => input.current?.click()}>
            <IconUpload />
            Choose files
          </Button>
          <Button variant="outline" onClick={() => start(testFile(20 * MiB))}>
            Upload a 20 MB test file
          </Button>
        </div>
        {uploads.length > 0 && (
          <ul className="flex flex-col divide-y">
            {uploads.map((upload) => (
              <UploadRow key={upload.id} upload={upload} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
