import { useCallback, useEffect, useState } from "react"
import type { DatasetSummary } from "../src/types"
import { api, type Status } from "./api"
import { DatasetView } from "./components/DatasetView"

function currentDataset(): string | null {
  const name = location.pathname.match(/^\/dataset\/(.+)$/)?.[1]
  return name ? decodeURIComponent(name) : null
}

export function navigate(path: string) {
  history.pushState(null, "", path)
  dispatchEvent(new PopStateEvent("popstate"))
}

export function App() {
  const [dataset, setDataset] = useState(currentDataset)
  const [status, setStatus] = useState<Status | null>(null)

  useEffect(() => {
    const onPop = () => setDataset(currentDataset())
    addEventListener("popstate", onPop)
    api
      .status()
      .then(setStatus)
      .catch(() => {})
    return () => removeEventListener("popstate", onPop)
  }, [])

  return (
    <div className="app">
      <header className="topbar">
        <a
          className="brand"
          href="/"
          onClick={(e) => {
            e.preventDefault()
            navigate("/")
          }}
        >
          LoRA Dataset Helper
        </a>
        {dataset && <span className="crumb">/ {dataset}</span>}
      </header>
      {status && !status.workerInstalled && (
        <div className="banner warn">
          The local analysis worker isn't installed. Run{" "}
          <code>bun run setup:worker</code>, then restart the server.
        </div>
      )}
      {status && !status.veniceKey && (
        <div className="banner warn">
          <code>VENICE_API_KEY</code> isn't set. Local analysis works, but AI
          review and captions need it. Copy <code>.env.example</code> to{" "}
          <code>.env</code> and restart.
        </div>
      )}
      {dataset ? (
        <DatasetView key={dataset} name={dataset} />
      ) : (
        <DatasetList status={status} />
      )}
    </div>
  )
}

function DatasetList({ status }: { status: Status | null }) {
  const [datasets, setDatasets] = useState<DatasetSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(
    () => api.datasets().then(setDatasets, (e) => setError(e.message)),
    [],
  )
  useEffect(() => {
    load()
  }, [load])

  return (
    <main className="page">
      <div className="page-head">
        <h1>Datasets</h1>
        <button type="button" onClick={load}>
          Refresh
        </button>
      </div>
      <p className="muted">
        Each sub-folder of <code>{status?.inputDir ?? "data/input"}</code> is a
        dataset. Put one character's images in a folder, then open it here.
        Results are copied to <code>{status?.outputDir ?? "data/output"}</code>.
        Input files are never changed.
      </p>
      {error && <div className="banner error">{error}</div>}
      {datasets && !datasets.length && (
        <div className="empty">
          No datasets yet. Create a folder such as{" "}
          <code>data/input/my-character/</code> and add images.
        </div>
      )}
      <div className="dataset-list">
        {datasets?.map((d) => (
          <a
            key={d.name}
            className="dataset-card"
            href={`/dataset/${encodeURIComponent(d.name)}`}
            onClick={(e) => {
              e.preventDefault()
              navigate(`/dataset/${encodeURIComponent(d.name)}`)
            }}
          >
            <strong>{d.name}</strong>
            <span>{d.imageCount} images</span>
            <span className="muted">
              {d.analyzed} analyzed · {d.tagged} AI-reviewed · {d.selected}{" "}
              selected · {d.captioned} captioned
            </span>
          </a>
        ))}
      </div>
    </main>
  )
}
