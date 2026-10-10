import { convexQuery } from "@convex-dev/react-query"
import { IconChecklist } from "@tabler/icons-react"
import { useSuspenseQuery } from "@tanstack/react-query"
import { api } from "@workspace/backend/api"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@workspace/ui/components/empty"
import { TaskItem } from "@/components/tasks/TaskItem"

/**
 * Everyone's tasks. The query is a live subscription, so changes
 * from any tab or device show up without a refresh.
 */
export function TaskList() {
  const { data: tasks } = useSuspenseQuery(convexQuery(api.tasks.list, {}))

  if (tasks.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <IconChecklist />
          </EmptyMedia>
          <EmptyTitle>No tasks yet</EmptyTitle>
          <EmptyDescription>
            Add one above. It shows up in every open tab.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  return (
    <ul className="flex flex-col divide-y">
      {tasks.map((task) => (
        <TaskItem key={task._id} task={task} />
      ))}
    </ul>
  )
}
