import { useConvexMutation } from "@convex-dev/react-query"
import { IconTrash } from "@tabler/icons-react"
import { useMutation } from "@tanstack/react-query"
import { api } from "@workspace/backend/api"
import type { Doc } from "@workspace/backend/dataModel"
import { Button } from "@workspace/ui/components/button"
import { Checkbox } from "@workspace/ui/components/checkbox"
import { toast } from "@workspace/ui/components/sonner"
import { toastError } from "@/lib/errors"

/** One task: a checkbox to complete it and a button to delete it. */
export function TaskItem({ task }: { task: Doc<"tasks"> }) {
  const toggle = useMutation({
    mutationFn: useConvexMutation(api.tasks.toggle),
    onError: toastError,
  })
  const remove = useMutation({
    mutationFn: useConvexMutation(api.tasks.remove),
    // Set on the hook, not on mutate(): the row unmounts as soon as the live
    // query drops the task, and mutate() callbacks don't run after that.
    onSuccess: () => toast.success("Task deleted"),
    onError: toastError,
  })

  return (
    <li className="flex items-center gap-3 py-2">
      <Checkbox
        checked={task.completed}
        onCheckedChange={() => toggle.mutate({ id: task._id })}
        aria-label={`Mark "${task.text}" as done`}
      />
      <span
        className={
          task.completed
            ? "flex-1 text-muted-foreground line-through"
            : "flex-1"
        }
      >
        {task.text}
      </span>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => remove.mutate({ id: task._id })}
        aria-label={`Delete "${task.text}"`}
      >
        <IconTrash />
      </Button>
    </li>
  )
}
