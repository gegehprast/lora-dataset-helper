import type { JobKind, JobState } from "./types";

export class Cancelled extends Error {
  constructor() {
    super("Cancelled");
  }
}

export interface JobContext {
  /** Set the current stage label and reset the counter. */
  stage(label: string, total: number): void;
  tick(n?: number): void;
  message(msg: string): void;
  /** Throws Cancelled if the user stopped the job. Call between units of work. */
  check(): void;
}

// Kept on globalThis so running jobs survive `bun --hot` reloads.
const g = globalThis as unknown as { __loraJobs?: Map<string, JobState>; __loraCancel?: Map<string, boolean> };
const jobs = (g.__loraJobs ??= new Map());
const cancelFlags = (g.__loraCancel ??= new Map());

export function getJob(dataset: string): JobState | null {
  return jobs.get(dataset) ?? null;
}

export function cancelJob(dataset: string) {
  if (jobs.get(dataset)?.running) cancelFlags.set(dataset, true);
}

/** Runs one job per dataset at a time. Returns immediately; progress is read via getJob(). */
export function startJob(dataset: string, kind: JobKind, fn: (ctx: JobContext) => Promise<string | void>): JobState {
  const existing = jobs.get(dataset);
  if (existing?.running) throw new Error(`A "${existing.kind}" job is already running for this dataset`);

  const state: JobState = {
    dataset,
    kind,
    stage: kind,
    done: 0,
    total: 0,
    running: true,
    error: null,
    message: null,
    startedAt: Date.now(),
    finishedAt: null,
  };
  jobs.set(dataset, state);
  cancelFlags.set(dataset, false);

  const ctx: JobContext = {
    stage(label, total) {
      state.stage = label;
      state.total = total;
      state.done = 0;
    },
    tick(n = 1) {
      state.done += n;
    },
    message(msg) {
      state.message = msg;
    },
    check() {
      if (cancelFlags.get(dataset)) throw new Cancelled();
    },
  };

  fn(ctx)
    .then((msg) => {
      if (msg) state.message = msg;
    })
    .catch((e: unknown) => {
      state.error = e instanceof Cancelled ? "Cancelled" : e instanceof Error ? e.message : String(e);
      if (!(e instanceof Cancelled)) console.error(`[job ${kind}/${dataset}]`, e);
    })
    .finally(() => {
      state.running = false;
      state.finishedAt = Date.now();
    });

  return state;
}

/** Run `fn` over items with bounded concurrency, honouring cancellation. */
export async function pool<T>(items: T[], concurrency: number, ctx: JobContext, fn: (item: T) => Promise<void>) {
  let next = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (next < items.length) {
      ctx.check();
      const item = items[next++]!;
      await fn(item);
      ctx.tick();
    }
  });
  await Promise.all(runners);
}
