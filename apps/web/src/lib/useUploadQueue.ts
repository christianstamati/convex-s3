import { toast } from "@workspace/ui/components/sonner"
import { type UploadApi, useUploadFile } from "convex-s3/react"
import { useState } from "react"
import { errorMessage } from "@/lib/errors"

export type Upload = {
  id: string
  name: string
  size: number
  fraction: number
  status: "uploading" | "done" | "failed" | "cancelled"
  error?: string
  controller: AbortController
}

/** The message of an upload error: a ConvexError's, or the browser's. */
function uploadError(error: unknown) {
  return error instanceof Error && !("data" in error)
    ? error.message
    : errorMessage(error, "The upload failed")
}

/**
 * Uploads through `api` (a module exporting `clientApi()`), keeping each
 * one's progress and a way to cancel it, newest first.
 */
export function useUploadQueue(api: UploadApi) {
  const uploadFile = useUploadFile(api)
  const [uploads, setUploads] = useState<Upload[]>([])

  const update = (id: string, patch: Partial<Upload>) =>
    setUploads((all) => all.map((u) => (u.id === id ? { ...u, ...patch } : u)))

  function start(file: File, prefix?: string) {
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
      prefix,
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
        const message = uploadError(error)
        update(id, { status: "failed", error: message })
        toast.error(message)
      })
  }

  /** Drops finished uploads from the list. */
  function clearFinished() {
    setUploads((all) => all.filter((u) => u.status === "uploading"))
  }

  return { uploads, start, clearFinished }
}
