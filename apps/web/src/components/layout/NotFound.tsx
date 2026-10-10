import { IconMapQuestion } from "@tabler/icons-react"
import { Link } from "@tanstack/react-router"
import { Button } from "@workspace/ui/components/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@workspace/ui/components/empty"

/** The page for URLs that match no route. */
export function NotFound() {
  return (
    <main className="flex min-h-svh p-6">
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <IconMapQuestion />
          </EmptyMedia>
          <EmptyTitle>Page not found</EmptyTitle>
          <EmptyDescription>
            The page you&apos;re looking for doesn&apos;t exist.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button
            render={<Link to="/" />}
            nativeButton={false}
            variant="outline"
          >
            Go home
          </Button>
        </EmptyContent>
      </Empty>
    </main>
  )
}
