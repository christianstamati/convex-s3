import { createFileRoute } from "@tanstack/react-router"
import { Hero } from "@/components/home/Hero"

export const Route = createFileRoute("/")({ component: HomePage })

function HomePage() {
  return (
    <main className="mx-auto flex min-h-svh max-w-xl flex-col justify-center p-6">
      <Hero />
    </main>
  )
}
