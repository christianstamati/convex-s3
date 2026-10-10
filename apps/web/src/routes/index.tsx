import { createFileRoute } from "@tanstack/react-router"
import { ExampleGrid } from "@/components/examples/ExampleGrid"
import { Hero } from "@/components/home/Hero"

export const Route = createFileRoute("/")({ component: HomePage })

function HomePage() {
  return (
    <main className="mx-auto flex min-h-svh max-w-3xl flex-col justify-center gap-10 p-6">
      <Hero />
      <ExampleGrid />
    </main>
  )
}
