import { Link } from "@tanstack/react-router"
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@workspace/ui/components/breadcrumb"
import { Fragment } from "react"

/** My Drive › Docs › 2026: each folder up the path is a link. */
export function DriveBreadcrumbs({ path }: { path: string }) {
  const segments = path.split("/").filter(Boolean)
  const crumbs = segments.map((name, i) => ({
    name,
    path: `${segments.slice(0, i + 1).join("/")}/`,
  }))

  return (
    <Breadcrumb>
      <BreadcrumbList>
        <BreadcrumbItem>
          {crumbs.length === 0 ? (
            <BreadcrumbPage>My Drive</BreadcrumbPage>
          ) : (
            <BreadcrumbLink
              render={<Link to="/examples/drive" search={{ path: "" }} />}
            >
              My Drive
            </BreadcrumbLink>
          )}
        </BreadcrumbItem>
        {crumbs.map((crumb, i) => (
          <Fragment key={crumb.path}>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              {i === crumbs.length - 1 ? (
                <BreadcrumbPage>{crumb.name}</BreadcrumbPage>
              ) : (
                <BreadcrumbLink
                  render={
                    <Link to="/examples/drive" search={{ path: crumb.path }} />
                  }
                >
                  {crumb.name}
                </BreadcrumbLink>
              )}
            </BreadcrumbItem>
          </Fragment>
        ))}
      </BreadcrumbList>
    </Breadcrumb>
  )
}
