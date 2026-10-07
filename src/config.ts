import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

export const ROOT = resolve(import.meta.dir, "..");
export const DATA_DIR = join(ROOT, "data");

export const paths = {
  input: join(DATA_DIR, "input"),
  output: join(DATA_DIR, "output"),
  cache: join(DATA_DIR, ".cache"),
  thumbs: join(DATA_DIR, ".cache", "thumbs"),
  models: join(DATA_DIR, ".cache", "models"),
  db: join(DATA_DIR, ".cache", "app.sqlite"),
  workerPython: join(ROOT, "worker", ".venv", "bin", "python"),
  workerScript: join(ROOT, "worker", "main.py"),
};

for (const dir of [paths.input, paths.output, paths.thumbs, paths.models]) {
  mkdirSync(dir, { recursive: true });
}

export const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".bmp"]);

export const PORT = Number(process.env.PORT ?? 3000);
export const VENICE_BASE_URL = process.env.VENICE_BASE_URL ?? "https://api.venice.ai/api/v1";

export function veniceKey(): string {
  const key = process.env.VENICE_API_KEY;
  if (!key) throw new Error("VENICE_API_KEY is not set. Copy .env.example to .env and add your key.");
  return key;
}
