import { site } from "@/lib/site"

/** The landing page intro. The examples follow it. */
export function Hero() {
  return (
    <div className="flex flex-col gap-2">
      <h1 className="font-heading font-semibold text-3xl tracking-tight">
        {site.name}
      </h1>
      <p className="text-muted-foreground">{site.description}</p>
    </div>
  )
}
