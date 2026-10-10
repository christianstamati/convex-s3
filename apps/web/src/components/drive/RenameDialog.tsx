import { useConvexAction } from "@convex-dev/react-query"
import { useMutation } from "@tanstack/react-query"
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
import { Input } from "@workspace/ui/components/input"
import { toast } from "@workspace/ui/components/sonner"
import { type FormEvent, useEffect, useState } from "react"
import type { DriveTarget } from "@/lib/driveTarget"
import { toastError } from "@/lib/errors"

/**
 * Renames a file (one S3 copy and delete) or a folder (a copy and delete
 * for every key under its prefix).
 */
export function RenameDialog({
  target,
  open,
  onOpenChange,
}: {
  target: DriveTarget
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [name, setName] = useState(target.name)
  useEffect(() => {
    if (open) setName(target.name)
  }, [open, target.name])

  const renameFile = useConvexAction(api.drive.renameFile)
  const renameFolder = useConvexAction(api.drive.renameFolder)
  const rename = useMutation({
    mutationFn: async (newName: string) => {
      if (target.kind === "file") {
        await renameFile({ key: target.key, name: newName })
      } else {
        await renameFolder({ path: target.path, name: newName })
      }
    },
    onSuccess: () => {
      toast.success("Renamed")
      onOpenChange(false)
    },
    onError: toastError,
  })

  function handleSubmit(event: FormEvent) {
    event.preventDefault()
    rename.mutate(name.trim())
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Rename</DialogTitle>
            <DialogDescription>
              {target.kind === "file"
                ? "S3 has no rename: the file is copied to its new key, then deleted."
                : "S3 has no folders: every key under this prefix is copied to the new one, then deleted."}
            </DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            aria-label="New name"
          />
          <DialogFooter>
            <Button
              type="submit"
              disabled={
                !name.trim() || name.trim() === target.name || rename.isPending
              }
            >
              {rename.isPending ? "Renaming…" : "Rename"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
