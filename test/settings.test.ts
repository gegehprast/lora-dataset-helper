import { expect, test } from "bun:test";
import { db, getSettings, saveSettings } from "../src/db";
import { DEFAULT_SETTINGS } from "../src/types";
import { newDataset } from "./helpers";

const stored = (ds: string) =>
  JSON.parse(db.query<{ settings: string }, [string]>("SELECT settings FROM datasets WHERE name = ?").get(ds)!.settings);

test("a new dataset gets the defaults", () => {
  expect(getSettings(newDataset())).toEqual(DEFAULT_SETTINGS);
});

test("only values that differ from the defaults are stored", () => {
  const ds = newDataset();
  saveSettings(ds, { targetCount: 12, diversity: DEFAULT_SETTINGS.diversity });
  expect(stored(ds)).toEqual({ targetCount: 12 });
  expect(getSettings(ds).targetCount).toBe(12);
});

test("setting a value back to its default removes it", () => {
  const ds = newDataset();
  saveSettings(ds, { localOnly: true });
  saveSettings(ds, { localOnly: false });
  expect(stored(ds)).toEqual({});
});

test("unknown keys are dropped", () => {
  const ds = newDataset();
  saveSettings(ds, { bogus: 1 } as any);
  expect(stored(ds)).toEqual({});
});

test("a partial framing mix is merged with the default mix", () => {
  const ds = newDataset();
  db.query("INSERT INTO datasets (name, settings) VALUES (?, ?)").run(ds, JSON.stringify({ framingMix: { full: 0.9 } }));
  expect(getSettings(ds).framingMix).toEqual({ ...DEFAULT_SETTINGS.framingMix, full: 0.9 });
});

test("the default models are private-only and the safeguard is on", () => {
  expect(DEFAULT_SETTINGS.privateModelsOnly).toBe(true);
  expect(DEFAULT_SETTINGS.localOnly).toBe(false);
});
