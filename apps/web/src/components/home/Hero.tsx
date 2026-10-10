import { Link } from "@tanstack/react-router"
import { Button } from "@workspace/ui/components/button"
import { site } from "@/lib/site"

/** The landing page intro, with a link to the dashboard. */
export function Hero() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="font-heading font-semibold text-3xl tracking-tight">
          {site.name}
        </h1>
        <p className="text-muted-foreground">{site.description}</p>
      </div>
      <div className="flex gap-2">
        <Button render={<Link to="/dashboard" />} nativeButton={false}>
          Open dashboard
        </Button>
      </div>
    </div>
  )
}
