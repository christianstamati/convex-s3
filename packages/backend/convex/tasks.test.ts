import { describe, expect, test } from "vitest"
import { api } from "./_generated/api"
import { setup } from "./test.setup"

describe("tasks", () => {
  test("creates, toggles and removes a task", async () => {
    const t = setup()

    const id = await t.mutation(api.tasks.create, { text: "  Ship it  " })
    expect(await t.query(api.tasks.list, {})).toMatchObject([
      { _id: id, text: "Ship it", completed: false },
    ])

    await t.mutation(api.tasks.toggle, { id })
    expect(await t.query(api.tasks.list, {})).toMatchObject([
      { completed: true },
    ])

    await t.mutation(api.tasks.remove, { id })
    expect(await t.query(api.tasks.list, {})).toEqual([])
  })

  test("rejects empty tasks", async () => {
    const t = setup()
    await expect(t.mutation(api.tasks.create, { text: "   " })).rejects.toThrow(
      "between 1 and 500"
    )
  })

  test("lists the newest task first", async () => {
    const t = setup()
    await t.mutation(api.tasks.create, { text: "First" })
    await t.mutation(api.tasks.create, { text: "Second" })
    expect(await t.query(api.tasks.list, {})).toMatchObject([
      { text: "Second" },
      { text: "First" },
    ])
  })

  test("refuses to change a task that no longer exists", async () => {
    const t = setup()
    const id = await t.mutation(api.tasks.create, { text: "Gone soon" })
    await t.mutation(api.tasks.remove, { id })
    await expect(t.mutation(api.tasks.toggle, { id })).rejects.toThrow(
      "Task not found"
    )
  })
})
