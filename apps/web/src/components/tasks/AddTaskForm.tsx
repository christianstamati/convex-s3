import { useConvexMutation } from "@convex-dev/react-query"
import { useMutation } from "@tanstack/react-query"
import { api } from "@workspace/backend/api"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { toast } from "@workspace/ui/components/sonner"
import { type FormEvent, useState } from "react"
import { toastError } from "@/lib/errors"

/** A one-line form that creates a task. */
export function AddTaskForm() {
  const [text, setText] = useState("")
  const create = useMutation({
    mutationFn: useConvexMutation(api.tasks.create),
    onError: toastError,
  })

  function handleSubmit(event: FormEvent) {
    event.preventDefault()
    // Clear right away so the next task can be typed while this one saves.
    // The live query in TaskList shows the task as soon as it's stored.
    setText("")
    create.mutate(
      { text },
      {
        onSuccess: () => toast.success("Task added"),
        onError: () => setText(text),
      }
    )
  }

  return (
    <form onSubmit={handleSubmit} className="flex gap-2">
      <Input
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder="What needs doing?"
        aria-label="New task"
      />
      <Button type="submit" disabled={!text.trim()}>
        Add
      </Button>
    </form>
  )
}
