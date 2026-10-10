import { useConvexAction } from "@convex-dev/react-query"
import { IconFolderPlus } from "@tabler/icons-react"
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
  DialogTrigger,
} from "@workspace/ui/components/dialog"
import { Input } from "@workspace/ui/components/input"
import { toast } from "@workspace/ui/components/sonner"
import { type FormEvent, useState } from "react"
import { toastError } from "@/lib/errors"

/** Creates a folder in the open one: a zero-byte marker at its prefix. */
export function NewFolderDialog({ path }: { path: string }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState("")
  const create = useMutation({
    mutationFn: useConvexAction(api.drive.createFolder),
    onError: toastError,
  })

  function handleSubmit(event: FormEvent) {
    event.preventDefault()
    create.mutate(
      { path, name },
      {
        onSuccess: () => {
          toast.success("Folder created")
          setOpen(false)
          setName("")
        },
      }
    )
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="outline" />}>
        <IconFolderPlus />
        New folder
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>New folder</DialogTitle>
            <DialogDescription>
              Saved as a zero-byte object whose key ends in a slash, as the S3
              console does.
            </DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Untitled folder"
            aria-label="Folder name"
          />
          <DialogFooter>
            <Button type="submit" disabled={!name.trim() || create.isPending}>
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
