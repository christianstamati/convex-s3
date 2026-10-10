import { Link } from "@tanstack/react-router"
import { site } from "@/lib/site"

/** The top bar of app pages. */
export function AppHeader() {
  return (
    <header className="border-b">
      <div className="mx-auto flex h-14 max-w-3xl items-center justify-between gap-4 px-6">
        <Link to="/" className="font-heading font-semibold">
          {site.name}
        </Link>
        <nav className="flex items-center gap-4 text-sm">
          <Link
            to="/examples"
            className="text-muted-foreground hover:text-foreground"
            activeProps={{ className: "text-foreground" }}
          >
            Examples
          </Link>
        </nav>
      </div>
    </header>
  )
}
