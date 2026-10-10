import { IconArrowRight } from "@tabler/icons-react"
import { Link } from "@tanstack/react-router"
import { Button } from "@workspace/ui/components/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@workspace/ui/components/card"
import { EXAMPLES } from "@/lib/examples"

/** Every example, with what it shows and a link to open it. */
export function ExampleGrid() {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {EXAMPLES.map((example) => (
        <Card key={example.slug}>
          <CardHeader>
            <example.icon className="size-6 text-muted-foreground" />
            <CardTitle>{example.title}</CardTitle>
            <CardDescription>{example.description}</CardDescription>
          </CardHeader>
          <CardContent className="flex-1">
            <ul className="flex list-disc flex-col gap-1 pl-5 text-muted-foreground text-sm">
              {example.shows.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </CardContent>
          <CardFooter>
            <Button render={<Link to={example.to} />} nativeButton={false}>
              Open {example.title}
              <IconArrowRight />
            </Button>
          </CardFooter>
        </Card>
      ))}
    </div>
  )
}
