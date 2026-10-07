import { existsSync } from "node:fs";
import type { Subprocess } from "bun";
import { paths } from "./config";

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

/**
 * Client for the long-lived Python analysis worker (worker/main.py).
 * Speaks newline-delimited JSON over the child's stdin/stdout. Started lazily,
 * restarted on the next call if it dies.
 */
export class PythonWorker {
  private proc: Subprocess<"pipe", "pipe", "inherit"> | null = null;
  private ready: Promise<void> | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  /** Requests are processed one at a time by the worker; queue them here so a timeout means "this request". */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private python = paths.workerPython,
    private script = paths.workerScript,
  ) {}

  private start(): Promise<void> {
    if (this.ready) return this.ready;
    if (!existsSync(this.python)) {
      return Promise.reject(new Error("Python worker is not set up. Run: bun run setup:worker"));
    }

    const proc = Bun.spawn([this.python, this.script], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
      env: { ...process.env, MODELS_DIR: paths.models, PYTHONUNBUFFERED: "1" },
    });
    this.proc = proc;

    let markReady!: () => void;
    let failReady!: (e: Error) => void;
    this.ready = new Promise<void>((res, rej) => {
      markReady = res;
      failReady = rej;
    });

    (async () => {
      const decoder = new TextDecoder();
      let buffer = "";
      for await (const chunk of proc.stdout) {
        buffer += decoder.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          let msg: { ready?: boolean; id?: number; ok?: boolean; result?: unknown; error?: string };
          try {
            msg = JSON.parse(line);
          } catch {
            console.warn("[worker] non-JSON output:", line.slice(0, 200));
            continue;
          }
          if (msg.ready) {
            markReady();
            continue;
          }
          const p = msg.id != null ? this.pending.get(msg.id) : undefined;
          if (!p) continue;
          this.pending.delete(msg.id!);
          if (msg.ok) p.resolve(msg.result);
          else p.reject(new Error(msg.error ?? "worker error"));
        }
      }
    })().catch((e) => console.error("[worker] reader failed:", e));

    proc.exited.then((code) => {
      const err = new Error(`Python worker exited (code ${code})`);
      failReady(err);
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
      if (this.proc === proc) {
        this.proc = null;
        this.ready = null;
      }
    });

    return this.ready;
  }

  call<T>(op: string, args: Record<string, unknown> = {}): Promise<T> {
    const run = async () => {
      await this.start();
      const id = this.nextId++;
      const result = new Promise<T>((resolve, reject) => {
        this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      });
      this.proc!.stdin.write(JSON.stringify({ id, op, args }) + "\n");
      this.proc!.stdin.flush();
      return result;
    };
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => {});
    return next;
  }

  stop() {
    if (!this.proc) return;
    try {
      this.proc.stdin.write(JSON.stringify({ id: 0, op: "shutdown" }) + "\n");
      this.proc.stdin.end();
    } catch {}
    const proc = this.proc;
    setTimeout(() => proc.kill(), 3000).unref();
  }
}

// Survives `bun --hot` reloads so we don't spawn a second Python process.
const g = globalThis as unknown as { __loraWorker?: PythonWorker };
export const worker = (g.__loraWorker ??= new PythonWorker());

export interface WorkerAnalysis {
  error?: string;
  width: number;
  height: number;
  sharpness: number;
  brightness: number;
  darkClip: number;
  brightClip: number;
  phash: string;
  aesthetic: number;
  clip: string; // base64 float32
  faces: {
    bbox: [number, number, number, number];
    det: number;
    sharpness: number;
    pose: [number, number, number] | null;
    age: number | null;
    sex: string | null;
    embedding: string; // base64 float32
  }[];
}
