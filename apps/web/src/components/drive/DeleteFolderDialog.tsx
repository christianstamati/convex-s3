import { useConvexMutation } from "@convex-dev/react-query"
import { useMutation } from "@tanstack/react-query"
import { api } from "@workspace/backend/api"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@workspace/ui/components/alert-dialog"
import { toast } from "@workspace/ui/components/sonner"
import { toastError } from "@/lib/errors"

/** Confirms deleting a folder and everything in it: one prefix delete. */
export function DeleteFolderDialog({
  folder,
  open,
  onOpenChange,
}: {
  folder: { name: string; path: string }
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const remove = useMutation({
    mutationFn: useConvexMutation(api.drive.removeFolder),
    // On the hook: the row unmounts as soon as the live list drops it.
    onSuccess: () => toast.success(`${folder.name} deleted`),
    onError: toastError,
  })

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete “{folder.name}”?</AlertDialogTitle>
          <AlertDialogDescription>
            Everything in it goes too: every object whose key starts with its
            prefix. This can't be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={remove.isPending}
            onClick={() => remove.mutate({ path: folder.path })}
          >
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
