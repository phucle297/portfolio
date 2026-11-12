/**
 * Contrast maths for the live-scene measurement (build-plan M3-AC5, M1-AC12; WCAG 2.2 1.4.3).
 * Pure functions only (unit-tested in tests/unit/contrast.test.ts); the browser driver is
 * tools/contrast/measure.ts.
 */

export type RGB = readonly [number, number, number];

/** sRGB channel (0–255) → linear light. */
function lin(c: number): number {
  const s = c / 255;
  return s <= 0.040_45 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** WCAG 2.x relative luminance of an sRGB colour with 0–255 channels. */
export function luminance([r, g, b]: RGB): number {
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio between two relative luminances (≥ 1). */
export function contrastRatio(a: number, b: number): number {
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

/** `alpha` of `fg` composited over an opaque `bg`. */
export function composite(fg: RGB, alpha: number, bg: RGB): RGB {
  const a = Math.min(1, Math.max(0, alpha));
  const mix = (f: number, b: number): number => f * a + b * (1 - a);
  return [mix(fg[0], bg[0]), mix(fg[1], bg[1]), mix(fg[2], bg[2])];
}

/** Value at quantile `q` (0–1) of a list, nearest-rank, without mutating the input. */
export function quantile(values: ArrayLike<number>, q: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = Float64Array.from(values).toSorted();
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[rank] ?? Number.NaN;
}

export interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** RGB of every pixel inside `boxes` (CSS px × `scale`) of an RGBA/RGB raw image. */
export function pixelsIn(
  image: { data: Uint8Array; width: number; height: number; channels: number },
  boxes: readonly Box[],
  scale = 1,
): RGB[] {
  const out: RGB[] = [];
  const seen = new Set<number>();
  for (const box of boxes) {
    const x0 = Math.max(0, Math.floor(box.x * scale));
    const y0 = Math.max(0, Math.floor(box.y * scale));
    const x1 = Math.min(image.width, Math.ceil((box.x + box.width) * scale));
    const y1 = Math.min(image.height, Math.ceil((box.y + box.height) * scale));
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        const index = y * image.width + x;
        if (seen.has(index)) continue;
        seen.add(index);
        const o = index * image.channels;
        out.push([image.data[o] ?? 0, image.data[o + 1] ?? 0, image.data[o + 2] ?? 0]);
      }
    }
  }
  return out;
}

export interface Worst {
  /** Contrast of the text colour against the worst-case background. */
  readonly ratio: number;
  /** The background colour used (the pixel at the worst-case luminance percentile). */
  readonly background: RGB;
  /** Text colour as rendered (its alpha × copy opacity composited over that background). */
  readonly text: RGB;
  /** "light" text is judged against the brightest 5 % of its background, "dark" the darkest 5 %. */
  readonly polarity: "light" | "dark";
}

/**
 * M3-AC5 worst case: the background behind the glyphs at its 95th-percentile luminance (for
 * light text; the 5th percentile for dark text on a light ground), against the text colour
 * composited at its effective alpha over that same pixel.
 */
export function worstCase(text: RGB, alpha: number, background: readonly RGB[]): Worst | null {
  if (background.length === 0) return null;
  const lum = background.map(luminance);
  const order = lum.map((_, i) => i).toSorted((a, b) => (lum[a] ?? 0) - (lum[b] ?? 0));
  const median = lum[order[Math.floor(order.length / 2)] ?? 0] ?? 0;
  const polarity = luminance(text) >= median ? "light" : "dark";
  const q = polarity === "light" ? 0.95 : 0.05;
  const rank = Math.min(order.length - 1, Math.max(0, Math.ceil(q * order.length) - 1));
  const bg = background[order[rank] ?? 0] ?? [0, 0, 0];
  const shown = composite(text, alpha, bg);
  return {
    ratio: contrastRatio(luminance(shown), luminance(bg)),
    background: bg,
    text: shown,
    polarity,
  };
}

/** Pass bar (build-plan §3 Contrast): H1/H2 and text ≥ 24 px need 3:1, everything else 4.5:1. */
export function requiredRatio(el: {
  tag: string;
  heading: string | null;
  fontSize: number;
}): number {
  if (el.heading === "H1" || el.heading === "H2" || /^H[12]$/.test(el.tag)) return 3;
  return el.fontSize >= 24 ? 3 : 4.5;
}

export const ACCENT: RGB = [0xff, 0x7a, 0x3d];

/** The italic accent half (#FF7A3D) is reported on its own (M3-AC5). */
export function isAccent(color: RGB): boolean {
  return color.every((c, i) => Math.abs(c - (ACCENT[i] ?? 0)) <= 2);
}

/** `rgb()/rgba()` (as returned by getComputedStyle) → channels + alpha. */
export function parseCssColor(value: string): { rgb: RGB; alpha: number } | null {
  const m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/i.exec(
    value.trim(),
  );
  if (!m) return null;
  const alphaText = m[4];
  let alpha = 1;
  if (alphaText !== undefined) {
    alpha = alphaText.endsWith("%") ? Number(alphaText.slice(0, -1)) / 100 : Number(alphaText);
  }
  return { rgb: [Number(m[1]), Number(m[2]), Number(m[3])], alpha };
}

/** One CSV field. */
export function csv(value: string | number): string {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
