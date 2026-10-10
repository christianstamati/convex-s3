import { IconChevronLeft } from "@tabler/icons-react"
import { Link } from "@tanstack/react-router"
import { Button } from "@workspace/ui/components/button"
import { EXAMPLES, type Example } from "@/lib/examples"

/** An example's title and description, with the way back to the others. */
export function ExampleHeader({ slug }: { slug: Example["slug"] }) {
  const example = EXAMPLES.find((e) => e.slug === slug)
  if (!example) return null
  return (
    <div className="flex flex-col gap-2">
      <Button
        variant="link"
        size="sm"
        className="self-start"
        render={<Link to="/examples" />}
        nativeButton={false}
      >
        <IconChevronLeft />
        Examples
      </Button>
      <h1 className="font-heading font-semibold text-2xl tracking-tight">
        {example.title}
      </h1>
      <p className="text-muted-foreground text-sm">{example.description}</p>
    </div>
  )
}
