/**
 * Size-budget measurement helpers (build-plan §3, M1-AC17). Pure functions only, so they are
 * unit-tested in tests/unit/budget.test.ts; the CLI that builds, loads the page and prints the
 * table is tools/budget/check.ts.
 */
import { gzipSync } from "node:zlib";

export const KB = 1000;

/** Bytes after `gzip -9` (the method §3 names for every JS budget). */
export function gzip9(data: string | Uint8Array): number {
  return gzipSync(data, { level: 9 }).byteLength;
}

/** Content types a static host serves compressed; everything else (woff2, avif, png) is counted raw. */
export function isCompressible(path: string): boolean {
  return /\.(?:html?|m?js|css|svg|json|xml|txt|webmanifest)$/i.test(path);
}

/** Bytes this file costs over the wire: gzip -9 for text, raw size for already-compressed formats. */
export function wireBytes(path: string, data: Uint8Array): number {
  return isCompressible(path) ? gzip9(data) : data.byteLength;
}

/** `src` of every external module/classic script in an HTML document, in document order. */
export function scriptSources(html: string): string[] {
  const out: string[] = [];
  for (const match of html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']?([^"'\s>]+)/gi)) {
    if (match[1]) out.push(match[1]);
  }
  return out;
}

/** Bodies of the inline `<script>` elements (no `src`) of an HTML document. */
export function inlineScripts(html: string): string[] {
  const out: string[] = [];
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const attributes = match[1] ?? "";
    const body = match[2] ?? "";
    if (
      !/\bsrc\s*=/i.test(attributes) &&
      !/type\s*=\s*["']?application\/(?:ld\+)?json/i.test(attributes) &&
      body.trim()
    ) {
      out.push(body);
    }
  }
  return out;
}

export interface ChunkImports {
  /** Specifiers loaded before the chunk runs (`import … from "x"`, `import "x"`, `export … from "x"`). */
  readonly staticImports: string[];
  /** Specifiers loaded on demand (`import("x")`). */
  readonly dynamicImports: string[];
}

const isRelative = (s: string | undefined): s is string => s !== undefined && /^\.{1,2}\//.test(s);

/** Relative import specifiers of a minified ES module chunk (Vite/Rollup output). */
export function chunkImports(code: string): ChunkImports {
  const staticImports = [...code.matchAll(/(?:\bfrom|\bimport)\s*["'`]([^"'`]+)["'`]/g)].map(
    (m) => m[1],
  );
  const dynamicImports = [...code.matchAll(/\bimport\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g)].map(
    (m) => m[1],
  );
  return {
    staticImports: [...new Set(staticImports.filter(isRelative))],
    dynamicImports: [...new Set(dynamicImports.filter(isRelative))],
  };
}

/**
 * Walk a chunk graph from its entries. Returns the files reached through static imports only
 * (what runs before any island) and, separately, the files only reachable through a dynamic
 * import (the lazy island), each as a path relative to the build root.
 */
export function walkChunks(
  entries: readonly string[],
  read: (file: string) => string,
  resolve: (from: string, specifier: string) => string,
): { initial: string[]; lazy: string[] } {
  const initial = new Set<string>();
  const visit = (file: string, into: Set<string>, lazyRoots: string[]): void => {
    if (into.has(file)) return;
    into.add(file);
    const { staticImports, dynamicImports } = chunkImports(read(file));
    for (const s of staticImports) visit(resolve(file, s), into, lazyRoots);
    for (const s of dynamicImports) lazyRoots.push(resolve(file, s));
  };
  const lazyRoots: string[] = [];
  for (const entry of entries) visit(entry, initial, lazyRoots);
  const lazy = new Set<string>();
  // `lazyRoots` grows while it is walked (lazy chunks can import() further chunks).
  for (const root of lazyRoots) {
    if (!initial.has(root)) visit(root, lazy, lazyRoots);
  }
  return { initial: [...initial], lazy: [...lazy].filter((f) => !initial.has(f)) };
}

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Decode one Base64 VLQ field list (a source-map segment) into integers. */
export function decodeVlq(segment: string): number[] {
  const values: number[] = [];
  let value = 0;
  let shift = 0;
  for (const char of segment) {
    const digit = BASE64.indexOf(char);
    if (digit < 0) throw new Error(`Invalid VLQ character "${char}"`);
    value += (digit & 31) << shift;
    if (digit & 32) {
      shift += 5;
    } else {
      const negative = value & 1;
      value >>>= 1;
      values.push(negative ? -value : value);
      value = 0;
      shift = 0;
    }
  }
  return values;
}

export interface SourceMapV3 {
  readonly sources: readonly string[];
  readonly mappings: string;
}

/** Narrow parsed JSON to the parts of a v3 source map this module reads. */
export function isSourceMap(value: unknown): value is SourceMapV3 {
  if (typeof value !== "object" || value === null) return false;
  if (!("mappings" in value) || !("sources" in value)) return false;
  const { sources, mappings } = value;
  return (
    typeof mappings === "string" &&
    Array.isArray(sources) &&
    sources.every((s) => typeof s === "string")
  );
}

/**
 * Split generated code into the parts that came from each source, using a v3 source map
 * (the approach of source-map-explorer). A span covered by a segment without a source (minifiers
 * emit these for glue such as `,` or `;` between statements) belongs to the module around it when
 * the nearest mapped spans before and after it come from the same source; otherwise, and for
 * bytes outside any module (chunk imports/exports), it goes to `null`. Returns the concatenated
 * text per source.
 */
export function attributeBySource(code: string, map: SourceMapV3): Map<string | null, string> {
  const spans: { source: string | null; text: string }[] = [];
  const lines = code.split("\n");
  const mappingLines = map.mappings.split(";");
  let sourceIndex = 0;
  lines.forEach((line, lineNo) => {
    let column = 0;
    let previousColumn = 0;
    let previousSource: string | null = null;
    for (const segment of (mappingLines[lineNo] ?? "").split(",").filter(Boolean)) {
      const fields = decodeVlq(segment);
      column += fields[0] ?? 0;
      spans.push({ source: previousSource, text: line.slice(previousColumn, column) });
      if (fields.length >= 4) {
        // fields[2], fields[3] (original line/column) are not needed for attribution.
        sourceIndex += fields[1] ?? 0;
        previousSource = map.sources[sourceIndex] ?? null;
      } else {
        previousSource = null;
      }
      previousColumn = column;
    }
    const newline = lineNo < lines.length - 1 ? "\n" : "";
    spans.push({ source: previousSource, text: line.slice(previousColumn) + newline });
  });

  const nearest = (from: number, step: 1 | -1): string | null => {
    for (let i = from + step; i >= 0 && i < spans.length; i += step) {
      const source = spans[i]?.source;
      if (source !== undefined && source !== null) return source;
    }
    return null;
  };
  const parts = new Map<string | null, string[]>();
  spans.forEach((span, i) => {
    if (!span.text) return;
    let { source } = span;
    if (source === null) {
      const before = nearest(i, -1);
      if (before !== null && before === nearest(i, 1)) source = before;
    }
    const list = parts.get(source);
    if (list) list.push(span.text);
    else parts.set(source, [span.text]);
  });
  return new Map([...parts].map(([source, list]) => [source, list.join("")]));
}

export type Status = "pass" | "fail";

export interface BudgetRow {
  readonly id: string;
  readonly label: string;
  /** Measured bytes (for "each" budgets, the largest item). */
  readonly bytes: number;
  /** Fail above this many bytes. */
  readonly limit: number;
  readonly detail?: string | undefined;
}

export const status = (row: BudgetRow): Status => (row.bytes <= row.limit ? "pass" : "fail");

export const kb = (bytes: number): string => `${(bytes / KB).toFixed(1)} KB`;

/** Fixed-width table for the terminal / CI log. */
export function formatTable(rows: readonly BudgetRow[]): string {
  const head = ["budget", "measured", "limit", "used", "result"];
  const body = rows.map((r) => [
    r.label,
    kb(r.bytes),
    `≤ ${kb(r.limit)}`,
    r.limit > 0 ? `${Math.round((r.bytes / r.limit) * 100)} %` : "-",
    status(r) === "pass" ? "PASS" : "FAIL",
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((b) => (b[i] ?? "").length)));
  const line = (cells: readonly string[]): string =>
    cells
      .map((c, i) => (i === 0 ? c.padEnd(widths[i] ?? 0) : c.padStart(widths[i] ?? 0)))
      .join("  ");
  return [line(head), widths.map((w) => "-".repeat(w)).join("  "), ...body.map(line)].join("\n");
}
