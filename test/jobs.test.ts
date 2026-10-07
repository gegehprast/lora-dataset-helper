import { expect, test } from "bun:test"
import { cancelJob, getJob, pool, startJob } from "../src/jobs"
import { fakeCtx, newDataset } from "./helpers"

const until = async (cond: () => boolean) => {
  for (let i = 0; i < 200 && !cond(); i++) await Bun.sleep(5)
}

test("runs a job and records its message and progress", async () => {
  const ds = newDataset("job")
  startJob(ds, "scan", async (ctx) => {
    ctx.stage("Working", 2)
    ctx.tick()
    ctx.tick()
    return "all done"
  })
  await until(() => !getJob(ds)!.running)
  expect(getJob(ds)).toMatchObject({
    running: false,
    message: "all done",
    error: null,
    done: 2,
    total: 2,
    stage: "Working",
  })
})

test("only one job per dataset at a time", async () => {
  const ds = newDataset("job")
  let release!: () => void
  startJob(ds, "scan", () => new Promise<void>((r) => (release = r)))
  expect(() => startJob(ds, "export", async () => {})).toThrow(
    "already running",
  )
  startJob(newDataset("job"), "scan", async () => {}) // other datasets are independent
  release()
  await until(() => !getJob(ds)!.running)
})

test("errors are recorded", async () => {
  const ds = newDataset("job")
  startJob(ds, "tag", async () => {
    throw new Error("boom")
  })
  await until(() => !getJob(ds)!.running)
  expect(getJob(ds)!.error).toBe("boom")
})

test("cancel stops the job at the next check", async () => {
  const ds = newDataset("job")
  let processed = 0
  startJob(ds, "tag", async (ctx) => {
    for (let i = 0; i < 100; i++) {
      ctx.check()
      processed++
      await Bun.sleep(2)
    }
  })
  await until(() => processed >= 3)
  cancelJob(ds)
  await until(() => !getJob(ds)!.running)
  expect(getJob(ds)!.error).toBe("Cancelled")
  expect(processed).toBeLessThan(100)
})

test("pool limits concurrency and ticks per item", async () => {
  const { ctx, state } = fakeCtx()
  let active = 0
  let peak = 0
  await pool([1, 2, 3, 4, 5, 6, 7], 3, ctx, async () => {
    peak = Math.max(peak, ++active)
    await Bun.sleep(5)
    active--
  })
  expect(peak).toBe(3)
  expect(state.ticks).toBe(7)
})
