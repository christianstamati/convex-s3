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
import { toast } from "@workspace/ui/components/sonner"
import { useUploadFile } from "convex-s3/react"
import { type ChangeEvent, useRef, useState } from "react"
import { type Upload, UploadRow } from "@/components/files/UploadRow"
import { errorMessage } from "@/lib/errors"

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
  const uploadFile = useUploadFile(api.files)
  const input = useRef<HTMLInputElement>(null)
  const [uploads, setUploads] = useState<Upload[]>([])

  const update = (id: string, patch: Partial<Upload>) =>
    setUploads((all) => all.map((u) => (u.id === id ? { ...u, ...patch } : u)))

  function start(file: File) {
    const id = crypto.randomUUID()
    const controller = new AbortController()
    setUploads((all) => [
      {
        id,
        name: file.name,
        size: file.size,
        fraction: 0,
        status: "uploading",
        controller,
      },
      ...all,
    ])
    uploadFile(file, {
      signal: controller.signal,
      onProgress: ({ fraction }) => update(id, { fraction }),
    })
      .then(() => {
        update(id, { status: "done", fraction: 1 })
        toast.success(`${file.name} uploaded`)
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) {
          update(id, { status: "cancelled" })
          return
        }
        const message =
          error instanceof Error && !("data" in error)
            ? error.message
            : errorMessage(error, "The upload failed")
        update(id, { status: "failed", error: message })
        toast.error(message)
      })
  }

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
