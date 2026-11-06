import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { BunSqliteAdapter } from "./db/bun-adapter";
import { performSearchWithMeta, type SearchMode } from "./engine";

const db = new Database(
  new URL("../../public/assets/data/kautian.db", import.meta.url).pathname,
  { readonly: true },
);
const adapter = new BunSqliteAdapter(db);
afterAll(() => db.close());

describe("romanization search", () => {
  const modes: SearchMode[] = [
    "hokkien_entry",
    "hokkien_example",
    "hokkien_fulltext",
  ];

  for (const mode of modes) {
    test(`${mode} matches composed and decomposed tone marks equally`, () => {
      const composed = performSearchWithMeta(adapter, "tāi", mode, {
        maxResults: 10,
      });
      const decomposed = performSearchWithMeta(
        adapter,
        "tāi".normalize("NFD"),
        mode,
        { maxResults: 10 },
      );

      expect(composed.results.length).toBeGreaterThan(0);
      expect(decomposed.results.map((result) => result.id)).toEqual(
        composed.results.map((result) => result.id),
      );
    });
  }

  test("preserves the requested tone", () => {
    const toned = performSearchWithMeta(adapter, "tāi", "hokkien_entry");
    expect(toned.results.length).toBeGreaterThan(0);
    expect(
      toned.results.every((result) =>
        result.romanization.toLowerCase().includes("tāi"),
      ),
    ).toBe(true);
  });
});
