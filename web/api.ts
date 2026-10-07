import type {
  DatasetSummary,
  ImageRecord,
  JobKind,
  JobState,
  Override,
  Settings,
  VeniceModel,
} from "../src/types"

export interface DatasetData {
  name: string
  settings: Settings
  images: ImageRecord[]
  job: JobState | null
}

export interface Status {
  veniceKey: boolean
  workerInstalled: boolean
  inputDir: string
  outputDir: string
}

async function call<T>(
  url: string,
  init?: { method?: string; body?: unknown },
): Promise<T> {
  const res = await fetch(url, {
    method: init?.method,
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
    body: init?.body ? JSON.stringify(init.body) : undefined,
  })
  const data = await res.json().catch(() => null)
  if (!res.ok) throw new Error(data?.error ?? `${res.status} ${res.statusText}`)
  return data as T
}

const ds = (name: string) => `/api/datasets/${encodeURIComponent(name)}`

export const api = {
  status: () => call<Status>("/api/status"),
  models: () => call<VeniceModel[]>("/api/models"),
  datasets: () => call<DatasetSummary[]>("/api/datasets"),
  dataset: (name: string) => call<DatasetData>(ds(name)),
  job: (name: string) => call<JobState | null>(`${ds(name)}/job`),
  saveSettings: (name: string, patch: Partial<Settings>) =>
    call<DatasetData>(`${ds(name)}/settings`, { method: "PATCH", body: patch }),
  startJob: (name: string, kind: JobKind, body: object = {}) =>
    call<JobState>(`${ds(name)}/jobs/${kind}`, { method: "POST", body }),
  cancel: (name: string) =>
    call<JobState>(`${ds(name)}/cancel`, { method: "POST" }),
  setOverride: (id: number, override: Override) =>
    call<DatasetData>(`/api/images/${id}`, {
      method: "PATCH",
      body: { override },
    }),
  setCaption: (id: number, caption: string) =>
    call<DatasetData>(`/api/images/${id}`, {
      method: "PATCH",
      body: { caption },
    }),
  regenerateCaption: (id: number) =>
    call<{ caption: string }>(`/api/images/${id}/caption`, { method: "POST" }),
  toggleReference: (id: number) =>
    call<DatasetData>(`/api/images/${id}/reference`, { method: "POST" }),
}

export const imageUrl = (id: number) => `/api/images/${id}/file`
export const thumbUrl = (hash: string) => `/thumbs/${hash}.webp`
