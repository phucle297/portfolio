import { describe, expect, it } from "vitest";
import {
  attributeBySource,
  chunkImports,
  decodeVlq,
  formatTable,
  gzip9,
  inlineScripts,
  scriptSources,
  status,
  walkChunks,
  wireBytes,
} from "../../tools/budget/lib.ts";

describe("budget: source-map attribution", () => {
  it("decodes Base64 VLQ segments", () => {
    expect(decodeVlq("AAAA")).toEqual([0, 0, 0, 0]);
    expect(decodeVlq("AACA")).toEqual([0, 0, 1, 0]);
    expect(decodeVlq("D")).toEqual([-1]);
    expect(decodeVlq("gB")).toEqual([16]);
    expect(decodeVlq("2HwcH")).toEqual([123, 456, -3]);
    expect(() => decodeVlq("!")).toThrow();
  });

  it("splits a chunk by source, keeping sourceless glue with the module around it", () => {
    // "aaa,bbb;ccc" — cols 0-2 from a.js, a sourceless ",", cols 4-6 from a.js, then b.js.
    const code = "aaa,bbb;ccc\nexport{x};";
    // seg1 col0 src0; seg2 col3 (no source); seg3 col4 src0; seg4 col7 src1 ; line 2: col0 no source
    const map = { sources: ["a.js", "b.js"], mappings: "AAAA,G,CAAA,GCAA;A" };
    const parts = attributeBySource(code, map);
    expect(parts.get("a.js")).toBe("aaa,bbb");
    expect(parts.get("b.js")).toBe(";ccc\n");
    expect(parts.get(null)).toBe("export{x};");
    const total = [...parts.values()].join("").length;
    expect(total).toBe(code.length);
  });
});

const resolve = (_from: string, s: string): string => `_astro/${s.replace("./", "")}`;

describe("budget: chunk graph", () => {
  const files: Record<string, string> = {
    "_astro/a.js": 'import{x}from"./shared.js";import"./side.js";const s=()=>import("./stage.js");',
    "_astro/b.js": 'import{y}from"./shared.js";',
    "_astro/shared.js": "export const x=1,y=2;",
    "_astro/side.js": "console.log(1);",
    "_astro/stage.js": 'import{x}from"./shared.js";import{t}from"./three.js";export{t};',
    "_astro/three.js": "export const t=3;",
  };
  const read = (f: string): string => files[f] ?? "";

  it("finds static and dynamic relative imports", () => {
    expect(chunkImports(read("_astro/a.js"))).toEqual({
      staticImports: ["./shared.js", "./side.js"],
      dynamicImports: ["./stage.js"],
    });
    expect(chunkImports('import{a}from"three";').staticImports).toEqual([]);
  });

  it("separates what runs before the island from the lazy chunks", () => {
    const { initial, lazy } = walkChunks(["_astro/a.js", "_astro/b.js"], read, resolve);
    expect(initial.toSorted()).toEqual([
      "_astro/a.js",
      "_astro/b.js",
      "_astro/shared.js",
      "_astro/side.js",
    ]);
    expect(lazy.toSorted()).toEqual(["_astro/stage.js", "_astro/three.js"]);
  });

  it("reads script tags from HTML", () => {
    const html =
      '<script type="module" src="/_astro/a.js"></script><script>var a=1</script>' +
      '<script type="application/ld+json">{}</script><script src=/x.js defer></script>';
    expect(scriptSources(html)).toEqual(["/_astro/a.js", "/x.js"]);
    expect(inlineScripts(html)).toEqual(["var a=1"]);
  });
});

describe("budget: sizes and verdicts", () => {
  it("gzips text and counts compressed formats raw", () => {
    const text = new TextEncoder().encode("a".repeat(10_000));
    expect(wireBytes("x.js", text)).toBe(gzip9(text));
    expect(wireBytes("x.js", text)).toBeLessThan(100);
    expect(wireBytes("x.woff2", text)).toBe(10_000);
    expect(wireBytes("x.avif", text)).toBe(10_000);
  });

  it("fails strictly above the limit and prints a FAIL row", () => {
    expect(status({ id: "a", label: "a", bytes: 15_000, limit: 15_000 })).toBe("pass");
    expect(status({ id: "a", label: "a", bytes: 15_001, limit: 15_000 })).toBe("fail");
    const table = formatTable([
      { id: "a", label: "Initial JS", bytes: 7_358, limit: 15_000 },
      { id: "b", label: "Textures", bytes: 1, limit: 0 },
    ]);
    expect(table).toMatch(/Initial JS\s+7\.4 KB\s+≤ 15\.0 KB\s+49 %\s+PASS/);
    expect(table).toMatch(/Textures\s+0\.0 KB\s+≤ 0\.0 KB\s+-\s+FAIL/);
  });
});
