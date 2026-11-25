/**
 * PF-92: 1st-percentile WCAG contrast against the painted backdrop (M3-AC5 method, one shot).
 * Glyphs are made transparent, the screenshot is the backdrop, leftover text-coloured pixels
 * are ignored, and the node's ratio is the 1st percentile of the rest.
 */
import type { Page } from "@playwright/test";

export const AA_NORMAL = 4.5;
export const AA_LARGE = 3;
export const RATIO_PERCENTILE = 0.01;
/** Relative luminance immediately behind the glyphs may vary by at most this across the scroll. */
export const LUM_SWING_MAX = 0.02;
/** Layout boxes of the heading, cards and price may move at most this many pixels. */
export const JUMP_PX = 0.5;

export interface GlyphTarget {
  readonly selector: string;
  /** When true, only text nodes whose parent is the matched element (skip e.g. the title's <em>). */
  readonly ownText?: boolean;
}

export interface ContrastRow {
  selector: string;
  text: string;
  size: number;
  large: boolean;
  required: number;
  ratio: number | null;
  p1: number | null;
  pixels: number;
  leftover: number;
  bgLumMin: number | null;
  bgLumMax: number | null;
  bgLumMean: number | null;
  visible: number;
  opacity: number;
  pass: boolean;
  reason: string;
}

const HIDE_ID = "pf92-hide-glyphs";
const HIDE_CSS = `*, *::before, *::after, *::marker, *::placeholder {
  -webkit-text-fill-color: transparent !important; text-decoration-color: transparent !important;
  text-shadow: none !important; caret-color: transparent !important; }`;

const srgbToLin = (c: number): number => {
  const x = c / 255;
  return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
};

export const relativeLuminance = (r: number, g: number, b: number): number =>
  0.2126 * srgbToLin(r) + 0.7152 * srgbToLin(g) + 0.0722 * srgbToLin(b);

export const wcagRatio = (l1: number, l2: number): number => {
  const hi = Math.max(l1, l2);
  const lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
};

interface TargetMeta {
  selector: string;
  text: string;
  size: number;
  large: boolean;
  opacity: number;
  visible: number;
  color: { r: number; g: number; b: number; a: number };
  rects: { x: number; y: number; w: number; h: number }[];
}

const collectMeta = (page: Page, targets: readonly GlyphTarget[]): Promise<TargetMeta[]> =>
  page.evaluate((list) => {
    const colorRe =
      /rgba?\(\s*([\d.]+)\s*[,\s]\s*([\d.]+)\s*[,\s]\s*([\d.]+)(?:\s*[,\s/]\s*([\d.]+))?\s*\)/i;
    const parse = (str: string): { r: number; g: number; b: number; a: number } | null => {
      const m = colorRe.exec(str.replace(/\s+/g, " "));
      if (!m) return null;
      return {
        r: Number(m[1]),
        g: Number(m[2]),
        b: Number(m[3]),
        a: m[4] === undefined ? 1 : Number(m[4]),
      };
    };
    const vw = innerWidth;
    const vh = innerHeight;
    const header = document.querySelector(".site-header");
    const headerBottomVar = Number.parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue("--header-bottom"),
    );
    const headerEdge = Number.isFinite(headerBottomVar)
      ? headerBottomVar
      : (header?.getBoundingClientRect().bottom ?? 0);
    // The 2 px .home-progress line sits flush under the header (z-index 21, accent fill).
    const clipTop = headerEdge + 2;
    const out: TargetMeta[] = [];
    for (const t of list) {
      const el = document.querySelector(t.selector);
      if (!(el instanceof HTMLElement)) continue;
      const cs = getComputedStyle(el);
      const parsed = parse(cs.color);
      if (!parsed) continue;
      let opacity = parsed.a;
      let n: HTMLElement | null = el;
      while (n) {
        opacity *= Number(getComputedStyle(n).opacity);
        n = n.parentElement;
      }
      const size = Number.parseFloat(cs.fontSize);
      const weight = Number.parseInt(cs.fontWeight, 10);
      const large = size >= 24 || (size >= 18.66 && weight >= 700);
      const rects: TargetMeta["rects"] = [];
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let text = "";
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const value = node.textContent ?? "";
        if (!value.trim()) continue;
        if (t.ownText && node.parentElement !== el) continue;
        text += value;
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const r of range.getClientRects()) {
          const x = Math.max(0, r.left);
          const y = Math.max(clipTop, r.top);
          const right = Math.min(vw, r.right);
          const bottom = Math.min(vh, r.bottom);
          if (right > x && bottom > y) rects.push({ x, y, w: right - x, h: bottom - y });
        }
      }
      const box = el.getBoundingClientRect();
      const visW = Math.max(0, Math.min(box.right, vw) - Math.max(box.left, 0));
      const visH = Math.max(0, Math.min(box.bottom, vh) - Math.max(box.top, clipTop));
      const visible = box.width * box.height > 0 ? (visW * visH) / (box.width * box.height) : 0;
      out.push({
        selector: t.selector,
        text: text.replace(/\s+/g, " ").trim(),
        size,
        large,
        opacity,
        visible,
        color: { ...parsed, a: opacity },
        rects,
      });
    }
    return out;
  }, targets);

const hideGlyphs = async (page: Page): Promise<() => Promise<void>> => {
  await page.evaluate(
    ({ id, css }) => {
      document.getElementById(id)?.remove();
      const style = document.createElement("style");
      style.id = id;
      style.textContent = `${css}
.home-progress { visibility: hidden !important; }`;
      document.documentElement.append(style);
    },
    { id: HIDE_ID, css: HIDE_CSS },
  );
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            resolve();
          });
        });
      }),
  );
  return async () => {
    await page.evaluate((id) => {
      document.getElementById(id)?.remove();
    }, HIDE_ID);
  };
};

export async function measureContrast(
  page: Page,
  targets: readonly GlyphTarget[],
): Promise<ContrastRow[]> {
  const meta = await collectMeta(page, targets);
  const show = await hideGlyphs(page);
  const png = await page.screenshot({ type: "png", animations: "disabled" });
  await show();
  const dpr = await page.evaluate(() => window.devicePixelRatio || 1);
  return page.evaluate(
    async ({ pngB64, meta: rows, dpr: scale, pTile }) => {
      // oxlint-disable-next-line unicorn/consistent-function-scoping -- runs in the page
      const toLin = (c: number): number => {
        const x = c / 255;
        return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
      };
      const lumOf = (r: number, g: number, b: number): number =>
        0.2126 * toLin(r) + 0.7152 * toLin(g) + 0.0722 * toLin(b);
      // oxlint-disable-next-line unicorn/consistent-function-scoping -- runs in the page
      const ratioOf = (l1: number, l2: number): number => {
        const hi = Math.max(l1, l2);
        const lo = Math.min(l1, l2);
        return (hi + 0.05) / (lo + 0.05);
      };
      const blob = await fetch(`data:image/png;base64,${pngB64}`).then((r) => r.blob());
      const bmp = await createImageBitmap(blob);
      const canvas = document.createElement("canvas");
      canvas.width = bmp.width;
      canvas.height = bmp.height;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) throw new Error("no 2d context");
      ctx.drawImage(bmp, 0, 0);
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const data = img.data;
      // oxlint-disable-next-line unicorn/consistent-function-scoping -- runs in the page
      const pct = (values: number[], p: number): number | null => {
        if (values.length === 0) return null;
        const sorted = values.toSorted((a, b) => a - b);
        return (
          sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * sorted.length)))] ?? null
        );
      };
      return rows.map((row) => {
        const required = row.large ? 3 : 4.5;
        const fgLum = lumOf(row.color.r, row.color.g, row.color.b);
        const ratios: number[] = [];
        const lums: number[] = [];
        let leftover = 0;
        const seen = new Set<number>();
        for (const r of row.rects) {
          const x0 = Math.max(0, Math.floor(r.x * scale));
          const y0 = Math.max(0, Math.floor(r.y * scale));
          const x1 = Math.min(canvas.width, Math.ceil((r.x + r.w) * scale));
          const y1 = Math.min(canvas.height, Math.ceil((r.y + r.h) * scale));
          for (let y = y0; y < y1; y += 1) {
            for (let x = x0; x < x1; x += 1) {
              const i = (y * canvas.width + x) * 4;
              if (seen.has(i)) continue;
              seen.add(i);
              const br = data[i] ?? 0;
              const bg = data[i + 1] ?? 0;
              const bb = data[i + 2] ?? 0;
              const bgLum = lumOf(br, bg, bb);
              // Leftover text-coloured pixels (glyphs that the hide style missed): ignore.
              if (ratioOf(fgLum, bgLum) < 1.2) {
                leftover += 1;
                continue;
              }
              const cr = row.color.r * row.color.a + br * (1 - row.color.a);
              const cg = row.color.g * row.color.a + bg * (1 - row.color.a);
              const cb = row.color.b * row.color.a + bb * (1 - row.color.a);
              ratios.push(ratioOf(lumOf(cr, cg, cb), bgLum));
              lums.push(bgLum);
            }
          }
        }
        const p1 = pct(ratios, pTile);
        const pass = p1 !== null && p1 >= required;
        let reason = "";
        if (p1 === null || ratios.length === 0) reason = "no painted glyph pixels";
        else if (!pass) reason = `contrast ${p1.toFixed(2)} < ${required}`;
        return {
          selector: row.selector,
          text: row.text,
          size: row.size,
          large: row.large,
          required,
          ratio: p1,
          p1,
          pixels: ratios.length,
          leftover,
          bgLumMin: lums.length ? Math.min(...lums) : null,
          bgLumMax: lums.length ? Math.max(...lums) : null,
          bgLumMean: lums.length ? lums.reduce((s, v) => s + v, 0) / lums.length : null,
          visible: row.visible,
          opacity: row.opacity,
          pass,
          reason,
        };
      });
    },
    { pngB64: png.toString("base64"), meta, dpr, pTile: RATIO_PERCENTILE },
  );
}

/** Scroll to timeline progress p (no scene hook required). */
export async function scrollToProgress(page: Page, p: number): Promise<void> {
  await page.evaluate((target) => {
    const max = Math.max(0, document.documentElement.scrollHeight - innerHeight);
    window.scrollTo({ top: target * max, behavior: "instant" });
  }, p);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const y = window.scrollY;
        requestAnimationFrame(() => {
          setTimeout(() => {
            if (window.scrollY === y) resolve();
            else {
              requestAnimationFrame(() => {
                setTimeout(() => {
                  resolve();
                }, 50);
              });
            }
          }, 80);
        });
      }),
  );
}

export const HEADING_TARGETS: readonly GlyphTarget[] = [
  { selector: ".services__head .eyebrow" },
  { selector: "#services-title", ownText: true },
  { selector: "#services-title em" },
  { selector: ".services__subline" },
];

export const SERVICES_TEXT_TARGETS: readonly GlyphTarget[] = [
  ...HEADING_TARGETS,
  { selector: ".services__list h3" },
  { selector: ".services__list p:last-child" },
  { selector: ".services__value" },
  { selector: ".services__note" },
];

export interface BoxRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface BoxMap {
  head: BoxRect | null;
  title: BoxRect | null;
  list: BoxRect | null;
  price: BoxRect | null;
}

export const readBoxes = (page: Page): Promise<BoxMap> =>
  page.evaluate(() => {
    // oxlint-disable-next-line unicorn/consistent-function-scoping -- runs in the page
    const box = (sel: string): BoxRect | null => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    };
    return {
      head: box(".services__head"),
      title: box("#services-title"),
      list: box(".services__list"),
      price: box(".services__price"),
    };
  });

const BOX_KEYS = ["head", "title", "list", "price"] as const;

export const boxDelta = (a: BoxMap, b: BoxMap): number => {
  let max = 0;
  for (const key of BOX_KEYS) {
    const left = a[key];
    const right = b[key];
    if (!left || !right) continue;
    max = Math.max(
      max,
      Math.abs(left.x - right.x),
      Math.abs(left.y - right.y),
      Math.abs(left.w - right.w),
      Math.abs(left.h - right.h),
    );
  }
  return max;
};

export const setPlateOpacity = (page: Page, opacity: number): Promise<void> =>
  page.evaluate((value) => {
    const el = document.querySelector<HTMLElement>("[data-services-plate]");
    if (!el) throw new Error("missing [data-services-plate]");
    el.style.setProperty("--services-plate-opacity", String(value));
  }, opacity);

export const headerBottomPx = (page: Page): Promise<number> =>
  page.evaluate(() => {
    const header = document.querySelector<HTMLElement>(".site-header");
    const fromVar = Number.parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue("--header-bottom"),
    );
    if (Number.isFinite(fromVar)) return fromVar;
    return header?.getBoundingClientRect().bottom ?? 0;
  });

/**
 * Count painted pixels of services heading colours inside the header band, with the header's
 * own glyphs hidden so they are not mistaken for Services copy showing through.
 */
export async function servicesPixelsInHeader(page: Page): Promise<number> {
  const bottom = await headerBottomPx(page);
  await page.evaluate(() => {
    const header = document.querySelector<HTMLElement>(".site-header");
    if (header) header.style.visibility = "hidden";
  });
  const png = await page.screenshot({ type: "png", animations: "disabled" });
  await page.evaluate(() => {
    const header = document.querySelector<HTMLElement>(".site-header");
    header?.style.removeProperty("visibility");
  });
  const dpr = await page.evaluate(() => window.devicePixelRatio || 1);
  return page.evaluate(
    async ({ pngB64, bottom: y, dpr: scale }) => {
      const blob = await fetch(`data:image/png;base64,${pngB64}`).then((r) => r.blob());
      const bmp = await createImageBitmap(blob);
      const canvas = document.createElement("canvas");
      canvas.width = bmp.width;
      canvas.height = bmp.height;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) throw new Error("no 2d context");
      ctx.drawImage(bmp, 0, 0);
      const img = ctx.getImageData(0, 0, canvas.width, Math.max(1, Math.ceil(y * scale)));
      const data = img.data;
      // Accent #ff7a3d, eyebrow #ffc24b, muted #c9b4a2 — header brand is #fff1e4, so skip body text.
      const targets: [number, number, number][] = [
        [255, 122, 61],
        [255, 194, 75],
        [201, 180, 162],
      ];
      let hits = 0;
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i] ?? 0;
        const g = data[i + 1] ?? 0;
        const b = data[i + 2] ?? 0;
        for (const [tr, tg, tb] of targets) {
          if (Math.abs(r - tr) + Math.abs(g - tg) + Math.abs(b - tb) <= 36) {
            hits += 1;
            break;
          }
        }
      }
      return hits;
    },
    { pngB64: png.toString("base64"), bottom, dpr },
  );
}
