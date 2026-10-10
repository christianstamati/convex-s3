import { convexQuery, useConvexAction } from "@convex-dev/react-query"
import { IconArrowUp, IconFolder } from "@tabler/icons-react"
import { keepPreviousData, useMutation, useQuery } from "@tanstack/react-query"
import { api } from "@workspace/backend/api"
import { Button } from "@workspace/ui/components/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog"
import { toast } from "@workspace/ui/components/sonner"
import { useEffect, useState } from "react"
import { type DriveTarget, parentPath } from "@/lib/driveTarget"
import { toastError } from "@/lib/errors"

/**
 * Moves a file or folder: browse to the destination, then move it there.
 * A folder can't go into itself or anything inside it.
 */
export function MoveDialog({
  target,
  open,
  onOpenChange,
}: {
  target: DriveTarget
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const from = parentPath(target)
  const [at, setAt] = useState(from)
  useEffect(() => {
    if (open) setAt(from)
  }, [open, from])

  const { data } = useQuery({
    ...convexQuery(api.drive.list, open ? { path: at } : "skip"),
    placeholderData: keepPreviousData,
  })

  const moveFile = useConvexAction(api.drive.moveFileTo)
  const moveFolder = useConvexAction(api.drive.moveFolderTo)
  const move = useMutation({
    mutationFn: async () => {
      if (target.kind === "file") {
        await moveFile({ key: target.key, path: at })
      } else {
        await moveFolder({ path: target.path, to: at })
      }
    },
    onSuccess: () => {
      toast.success(`Moved to ${at === "" ? "My Drive" : at.slice(0, -1)}`)
      onOpenChange(false)
    },
    onError: toastError,
  })

  const insideItself = target.kind === "folder" && at.startsWith(target.path)
  const up = at.slice(0, at.slice(0, -1).lastIndexOf("/") + 1)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Move “{target.name}”</DialogTitle>
          <DialogDescription>
            To: {at === "" ? "My Drive" : `My Drive/${at.slice(0, -1)}`}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col">
          {at !== "" && (
            <Button
              variant="ghost"
              className="justify-start"
              onClick={() => setAt(up)}
            >
              <IconArrowUp />
              Up
            </Button>
          )}
          {data?.folders
            .filter(
              (folder) =>
                target.kind !== "folder" || folder.path !== target.path
            )
            .map((folder) => (
              <Button
                key={folder.path}
                variant="ghost"
                className="justify-start"
                onClick={() => setAt(folder.path)}
              >
                <IconFolder />
                {folder.name}
              </Button>
            ))}
          {data && data.folders.length === 0 && (
            <p className="py-2 text-muted-foreground text-sm">
              No folders here.
            </p>
          )}
        </div>
        <DialogFooter>
          <Button
            disabled={at === from || insideItself || move.isPending}
            onClick={() => move.mutate()}
          >
            {move.isPending ? "Moving…" : "Move here"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
