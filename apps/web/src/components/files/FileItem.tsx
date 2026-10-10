import { useConvexMutation } from "@convex-dev/react-query"
import { IconDownload, IconTrash } from "@tabler/icons-react"
import { useMutation } from "@tanstack/react-query"
import { api } from "@workspace/backend/api"
import type { Id } from "@workspace/backend/dataModel"
import { Button } from "@workspace/ui/components/button"
import { toast } from "@workspace/ui/components/sonner"
import { toastError } from "@/lib/errors"
import { formatBytes } from "@/lib/format"

type File = {
  _id: Id<"files">
  name: string
  size: number
  contentType?: string
  url: string
}

/** One stored file: its name, size and type, a download and a delete. */
export function FileItem({ file }: { file: File }) {
  const remove = useMutation({
    mutationFn: useConvexMutation(api.files.remove),
    // On the hook: the row unmounts as soon as the live list drops it.
    onSuccess: () => toast.success("File deleted"),
    onError: toastError,
  })

  return (
    <li className="flex items-center gap-3 py-2">
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm">{file.name}</span>
        <span className="text-muted-foreground text-xs">
          {formatBytes(file.size)}
          {file.contentType ? ` · ${file.contentType}` : ""}
        </span>
      </div>
      <Button
        variant="ghost"
        size="icon-sm"
        render={<a href={file.url} aria-label={`Download ${file.name}`} />}
        nativeButton={false}
      >
        <IconDownload />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        disabled={remove.isPending}
        onClick={() => remove.mutate({ id: file._id })}
        aria-label={`Delete ${file.name}`}
      >
        <IconTrash />
      </Button>
    </li>
  )
}
