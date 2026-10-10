import { useConvexMutation } from "@convex-dev/react-query"
import {
  IconDotsVertical,
  IconDownload,
  IconFile,
  IconFileText,
  IconFolderSymlink,
  IconMovie,
  IconPencil,
  IconPhoto,
  IconTrash,
} from "@tabler/icons-react"
import { useMutation } from "@tanstack/react-query"
import { api } from "@workspace/backend/api"
import { Button } from "@workspace/ui/components/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu"
import { toast } from "@workspace/ui/components/sonner"
import { useState } from "react"
import { MoveDialog } from "@/components/drive/MoveDialog"
import { RenameDialog } from "@/components/drive/RenameDialog"
import { toastError } from "@/lib/errors"
import { formatBytes, formatDate } from "@/lib/format"

type DriveFile = {
  key: string
  name: string
  size: number
  contentType?: string
  lastModified: number
  url: string
  downloadUrl: string
}

function iconFor(contentType: string | undefined) {
  if (contentType?.startsWith("image/")) return IconPhoto
  if (contentType?.startsWith("video/")) return IconMovie
  if (contentType?.startsWith("text/") || contentType === "application/pdf") {
    return IconFileText
  }
  return IconFile
}

/** A file: opens in a new tab, with download, rename, move and delete. */
export function DriveFileRow({ file }: { file: DriveFile }) {
  const [dialog, setDialog] = useState<"rename" | "move" | null>(null)
  const remove = useMutation({
    mutationFn: useConvexMutation(api.drive.removeFile),
    // On the hook: the row unmounts as soon as the live list drops it.
    onSuccess: () => toast.success(`${file.name} deleted`),
    onError: toastError,
  })
  const target = { kind: "file" as const, key: file.key, name: file.name }
  const onOpenChange = (open: boolean) => {
    if (!open) setDialog(null)
  }
  const Icon = iconFor(file.contentType)

  return (
    <li className="flex items-center gap-3 py-2">
      <a
        href={file.url}
        target="_blank"
        rel="noreferrer"
        className="flex min-w-0 flex-1 items-center gap-3 text-sm hover:underline"
      >
        <Icon className="size-5 shrink-0 text-muted-foreground" />
        <span className="truncate">{file.name}</span>
      </a>
      <span className="hidden w-20 text-right text-muted-foreground text-sm tabular-nums sm:block">
        {formatBytes(file.size)}
      </span>
      <span className="hidden w-28 text-muted-foreground text-sm sm:block">
        {formatDate(file.lastModified)}
      </span>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Actions for ${file.name}`}
            />
          }
        >
          <IconDotsVertical />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem render={<a href={file.downloadUrl} />}>
            <IconDownload />
            Download
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setDialog("rename")}>
            <IconPencil />
            Rename
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setDialog("move")}>
            <IconFolderSymlink />
            Move to…
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            disabled={remove.isPending}
            onClick={() => remove.mutate({ key: file.key })}
          >
            <IconTrash />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <RenameDialog
        target={target}
        open={dialog === "rename"}
        onOpenChange={onOpenChange}
      />
      <MoveDialog
        target={target}
        open={dialog === "move"}
        onOpenChange={onOpenChange}
      />
    </li>
  )
}
