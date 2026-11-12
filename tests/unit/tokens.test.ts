import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Token drift guard (PF-28, M1-AC12). `src/shared/ui/tokens/tokens.css` is the one source:
 * - its values match design.md "Tokens" (round7 darkroom-morph) exactly;
 * - no token is defined twice, there or anywhere else in src/;
 * - no token value is hard-coded outside it (palette hex, opaque rgb, the easing curves and the
 *   motion durations), except the files listed in HARD_CODED_OK, each with its reason;
 * - every `var(--x)` used in src/ resolves to a token or a property some component defines.
 */
const root = resolve(import.meta.dirname, "../..");
const src = join(root, "src");
const TOKENS_FILE = join(src, "shared/ui/tokens/tokens.css");

/** design.md "Tokens", verbatim. */
const DESIGN = {
  "--bg": "#0e0a08",
  "--surface": "#1a1210",
  "--surface-2": "#251a16",
  "--line": "#3a2a22",
  "--line-strong": "#8a6d5d",
  "--text": "#fff1e4",
  "--muted": "#c9b4a2",
  "--accent": "#ff7a3d",
  "--accent-2": "#ffc24b",
  "--ink": "#0e0a08",
  "--focus": "#ffe1b5",
  "--error": "#ff8ba8",
  "--ease-out": "cubic-bezier(0.16, 1, 0.3, 1)",
  "--ease-inout": "cubic-bezier(0.65, 0, 0.35, 1)",
  "--t-micro": "160ms",
  "--t-ui": "320ms",
  "--t-enter": "560ms",
  "--t-stagger": "60ms",
  "--scrim-desktop": "linear-gradient(90deg, rgb(14 10 8 / 0.86) 0 38%, transparent 70%)",
  "--scrim-card": "rgb(14 10 8 / 0.78)",
  // design.md §8 (mobile) and the approved prototype (desktop): px / 16 = rem.
  "--type-h1-mobile": "3.5rem",
  "--type-h2-mobile": "2.75rem",
  "--type-body-mobile": "1rem",
  "--leading-body": "1.55",
  "--type-h1-desktop": "7.75rem",
  "--type-h2-desktop": "6.5rem",
  "--type-body-desktop": "1.125rem",
  "--type-eyebrow-desktop": "0.8125rem",
  "--type-mono-desktop": "0.75rem",
} as const;

/** The token groups PF-28 AC1 requires. */
const REQUIRED = [
  "bg",
  "surface",
  "surface-2",
  "line",
  "line-strong",
  "text",
  "muted",
  "accent",
  "accent-2",
  "ink",
  "focus",
  "error",
  "font-sans",
  "font-serif",
  "font-mono",
  "space-1",
  "space-4",
  "space-8",
  "radius-sm",
  "radius-md",
  "radius-pill",
  "ease-out",
  "ease-inout",
  "t-micro",
  "t-ui",
  "t-enter",
  "t-stagger",
]
  .concat(
    ["h1", "h2", "body", "eyebrow", "mono"].flatMap((s) => [
      `type-${s}-desktop`,
      `type-${s}-mobile`,
    ]),
  )
  .map((n) => `--${n}`);

/** Files that must carry literal token values, and why. Their literals are checked too. */
const HARD_CODED_OK: Record<string, string> = {
  "src/shared/config/site.ts": "<meta name=theme-color> needs a literal colour (must equal --bg)",
  "src/_pages/home/lib/atlases.ts":
    "canvas 2D textures for the 3D scene: canvas fill styles cannot read CSS custom properties",
};

const files = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((f) => /\.(css|astro|ts|mjs)$/u.test(f))
    .map((f) => join(dir, f));

const read = (file: string): string => readFileSync(file, "utf8");
const rel = (file: string): string => relative(root, file);
/** CSS that a file ships: whole .css files, and the <style> blocks of .astro files. */
const cssOf = (file: string): string =>
  file.endsWith(".css")
    ? read(file)
    : file.endsWith(".astro")
      ? [...read(file).matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gu)].map((m) => m[1]).join("\n")
      : "";
const stripComments = (css: string): string => css.replaceAll(/\/\*[\s\S]*?\*\//gu, "");

function declarations(css: string): [string, string][] {
  const body = /:root\s*\{([\s\S]*?)\n\}/u.exec(stripComments(css))?.[1] ?? "";
  return [...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/gu)].map((m) => [
    m[1] ?? "",
    (m[2] ?? "").replaceAll(/\s+/gu, " ").trim(),
  ]);
}

const tokenCss = read(TOKENS_FILE);
const tokens = declarations(tokenCss);
const tokenMap = new Map(tokens);
const others = files(src).filter((f) => f !== TOKENS_FILE);

const hex = (h: string): RegExp => new RegExp(`#${h.slice(1)}\\b`, "iu");
const rgbOf = (h: string): string =>
  [1, 3, 5].map((i) => Number.parseInt(h.slice(i, i + 2), 16)).join("[ ,]+");

describe("design tokens (PF-28)", () => {
  it("defines every required token", () => {
    expect(REQUIRED.filter((n) => !tokenMap.has(n))).toEqual([]);
  });

  it("matches design.md Tokens exactly", () => {
    const drift = Object.entries(DESIGN)
      .filter(([name, value]) => tokenMap.get(name)?.toLowerCase() !== value)
      .map(([name, value]) => `${name}: ${tokenMap.get(name) ?? "missing"} ≠ ${value}`);
    expect(drift).toEqual([]);
  });

  it("defines each token once, and nowhere else", () => {
    const names = tokens.map(([n]) => n);
    expect(names.filter((n, i) => names.indexOf(n) !== i)).toEqual([]);
    const redefined = others.flatMap((f) => {
      const css = stripComments(f.endsWith(".ts") || f.endsWith(".mjs") ? read(f) : cssOf(f));
      return names
        .filter((n) => new RegExp(`(^|[\\s;{(,"'])${n}\\s*:`, "mu").test(css))
        .map((n) => `${rel(f)} redefines ${n}`);
    });
    expect(redefined).toEqual([]);
  });

  it("hard-codes no token value outside the token source", () => {
    const palette = Array.from(new Set(Object.values(DESIGN).filter((v) => v.startsWith("#"))));
    const motion = [
      /cubic-bezier\(\s*0?\.16\s*,\s*1\s*,\s*0?\.3\s*,\s*1\s*\)/u,
      /cubic-bezier\(\s*0?\.65\s*,\s*0\s*,\s*0?\.35\s*,\s*1\s*\)/u,
      /(?<![\w.])(160|320|560|60)ms\b/u,
    ];
    const found = others.flatMap((f) => {
      if (HARD_CODED_OK[rel(f)]) return [];
      const text = stripComments(f.endsWith(".ts") || f.endsWith(".mjs") ? read(f) : cssOf(f));
      const colours = palette
        .filter(
          (h) => hex(h).test(text) || new RegExp(`rgba?\\(${rgbOf(h)}\\s*\\)`, "u").test(text),
        )
        .map((h) => `${rel(f)}: ${h}`);
      const css = f.endsWith(".ts") || f.endsWith(".mjs") ? "" : text;
      const curves = motion.filter((m) => m.test(css)).map((m) => `${rel(f)}: ${m.source}`);
      return colours.concat(curves);
    });
    expect(found, "use var(--token) instead").toEqual([]);
  });

  it("keeps the allowed literals equal to their tokens", () => {
    const palette = new Set<string>(Object.values(DESIGN).filter((v) => v.startsWith("#")));
    expect(read(join(root, "src/shared/config/site.ts"))).toMatch(
      new RegExp(`themeColor:\\s*"${tokenMap.get("--bg") ?? "missing"}"`, "iu"),
    );
    for (const file of Object.keys(HARD_CODED_OK)) {
      const literals = [...read(join(root, file)).matchAll(/#[0-9a-f]{6}\b/giu)].map((m) =>
        m[0].toLowerCase(),
      );
      // Near-miss guard: a literal within 2 steps per channel of a token must be that token.
      const near = literals.filter(
        (l) =>
          !palette.has(l) &&
          [...palette].some((p) =>
            [1, 3, 5].every(
              (i) =>
                Math.abs(
                  Number.parseInt(l.slice(i, i + 2), 16) - Number.parseInt(p.slice(i, i + 2), 16),
                ) <= 2,
            ),
          ),
      );
      expect(near, `${file}: near-miss of a token colour`).toEqual([]);
    }
  });

  it("resolves every var(--x) used in src/", () => {
    const defined = new Set<string>(tokens.map(([n]) => n));
    const all = files(src);
    for (const f of all) {
      const text = read(f);
      for (const m of text.matchAll(/(--[\w-]+)\s*:/gu)) defined.add(m[1] ?? "");
      for (const m of text.matchAll(/setProperty\(\s*["'`](--[\w-]+)/gu)) defined.add(m[1] ?? "");
    }
    const unresolved = all.flatMap((f) =>
      [...cssOf(f).matchAll(/var\(\s*(--[\w-]+)/gu)]
        .map((m) => m[1] ?? "")
        .filter((n) => !defined.has(n))
        .map((n) => `${rel(f)}: ${n}`),
    );
    expect([...new Set(unresolved)]).toEqual([]);
  });
});
