// PythonWorker protocol handling, using a tiny fake worker script (no models, no venv needed).
import { afterAll, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PythonWorker } from "../src/worker"

const dir = mkdtempSync(join(tmpdir(), "lora-worker-"))
const script = join(dir, "fake_worker.py")
await Bun.write(
  script,
  `import json, os, sys
print("noise before ready")            # non-JSON output must be ignored
sys.stdout.write(json.dumps({"ready": True}) + "\\n"); sys.stdout.flush()
for line in sys.stdin:
    msg = json.loads(line)
    op, args = msg["op"], msg.get("args") or {}
    if op == "echo":
        out = {"id": msg["id"], "ok": True, "result": args}
    elif op == "fail":
        out = {"id": msg["id"], "ok": False, "error": "ValueError: nope"}
    elif op == "crash":
        os._exit(3)
    else:
        out = {"id": msg["id"], "ok": False, "error": "unknown op"}
    sys.stdout.write(json.dumps(out) + "\\n"); sys.stdout.flush()
`,
)

const python = Bun.which("python3")!
const w = new PythonWorker(python, script)
afterAll(() => w.stop())

test("round-trips requests in order", async () => {
  const results = await Promise.all(
    [1, 2, 3].map((n) => w.call<{ n: number }>("echo", { n })),
  )
  expect(results.map((r) => r.n)).toEqual([1, 2, 3])
})

test("worker errors reject only that call", async () => {
  await expect(w.call("fail")).rejects.toThrow("ValueError: nope")
  expect(await w.call<{ ok: number }>("echo", { ok: 1 })).toEqual({ ok: 1 })
})

test("a crash rejects the pending call, and the next call restarts the worker", async () => {
  await expect(w.call("crash")).rejects.toThrow("exited (code 3)")
  expect(await w.call<{ again: boolean }>("echo", { again: true })).toEqual({
    again: true,
  })
})

test("a missing interpreter gives a setup hint", async () => {
  await expect(
    new PythonWorker(join(dir, "nope", "python"), script).call("echo"),
  ).rejects.toThrow("setup:worker")
})
