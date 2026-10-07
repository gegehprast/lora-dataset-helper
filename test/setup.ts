// Runs before any test file is loaded (see bunfig.toml).
// - All app data goes to a throwaway folder, never the real data/ directory.
// - The real Venice key from .env is replaced, and every real network call fails the test:
//   tests must stub fetch explicitly (see test/helpers.ts → mockFetch).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "lora-test-"));
process.env.LORA_DATA_DIR = dir;
process.env.VENICE_API_KEY = "test-key";
process.env.VENICE_BASE_URL = "http://venice.test/api/v1";

const realFetch = globalThis.fetch;
globalThis.fetch = Object.assign(
  async (input: RequestInfo | URL) => {
    throw new Error(`Unmocked network request in test: ${String(input instanceof Request ? input.url : input)}`);
  },
  { preconnect: realFetch.preconnect },
) as typeof fetch;

process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
