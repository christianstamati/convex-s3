import { IconX } from "@tabler/icons-react"
import { Button } from "@workspace/ui/components/button"
import { Progress } from "@workspace/ui/components/progress"
import { formatBytes } from "@/lib/format"

export type Upload = {
  id: string
  name: string
  size: number
  fraction: number
  status: "uploading" | "done" | "failed" | "cancelled"
  error?: string
  controller: AbortController
}

const STATUS: Record<Upload["status"], string> = {
  uploading: "Uploading",
  done: "Uploaded",
  failed: "Failed",
  cancelled: "Cancelled",
}

/** One upload in progress (or just finished), with Cancel while it runs. */
export function UploadRow({ upload }: { upload: Upload }) {
  const percent = Math.round(upload.fraction * 100)
  return (
    <li className="flex items-center gap-3 py-3">
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex items-baseline justify-between gap-3 text-sm">
          <span className="truncate">{upload.name}</span>
          <span className="shrink-0 text-muted-foreground tabular-nums">
            {upload.status === "uploading"
              ? `${percent}% of ${formatBytes(upload.size)}`
              : (upload.error ??
                `${STATUS[upload.status]}, ${formatBytes(upload.size)}`)}
          </span>
        </div>
        <Progress value={percent} aria-label={`${upload.name} progress`} />
      </div>
      <Button
        variant="ghost"
        size="icon-sm"
        disabled={upload.status !== "uploading"}
        onClick={() => upload.controller.abort()}
        aria-label={`Cancel ${upload.name}`}
      >
        <IconX />
      </Button>
    </li>
  )
}
