import sharp from "sharp";

/**
 * PF-87: where the hero tray sits in a frame, compared between two frames (the still and the live
 * scene, or two live frames). Tone may differ (the PF-84 luminance/dE rules judge that); geometry
 * must not. So the comparison is geometric: the lit tray's bounding box gives a first guess, then
 * a similarity transform (scale, rotation, shift) is fitted on edges (gradient magnitude), which
 * do not move when the light changes. The result is how far each corner of the tray box moves
 * under that transform and its rotation.
 */

export interface Gray {
  width: number;
  height: number;
  luma: Float32Array;
  grad: Float32Array;
}

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface PoseDelta {
  /** Largest corner displacement of the tray box (px). */
  corner: number;
  /** Rotation (degrees). */
  tilt: number;
  scale: number;
  dx: number;
  dy: number;
  /** Mean edge strength matched (0-1 of the reference's own); low = no real match. */
  match: number;
  ref: Box;
  box: Box;
}

const LIT = 120;

export async function gray(png: Buffer): Promise<Gray> {
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const luma = new Float32Array(width * height);
  for (let i = 0; i < width * height; i += 1)
    luma[i] =
      0.2126 * (data[i * 3] ?? 0) +
      0.7152 * (data[i * 3 + 1] ?? 0) +
      0.0722 * (data[i * 3 + 2] ?? 0);
  const grad = new Float32Array(width * height);
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const i = y * width + x;
      grad[i] =
        Math.abs((luma[i + 1] ?? 0) - (luma[i - 1] ?? 0)) +
        Math.abs((luma[i + width] ?? 0) - (luma[i - width] ?? 0));
    }
  }
  return { width, height, luma, grad };
}

/** Bounding box of the lit tray (luminance >= 120), or null when nothing is lit. */
export function litBox(g: Gray): Box | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  let n = 0;
  for (let y = 0; y < g.height; y += 1) {
    for (let x = 0; x < g.width; x += 1) {
      if ((g.luma[y * g.width + x] ?? 0) < LIT) continue;
      n += 1;
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
  }
  return n < 5000 ? null : { x0, y0, x1, y1 };
}

const range = (mid: number, half: number, step: number): number[] => {
  const out: number[] = [];
  for (let v = mid - half; v <= mid + half + 1e-9; v += step) out.push(v);
  return out;
};

/** Fit `cur` onto `ref` (similarity transform about the ref box centre) and report the delta. */
export function poseDelta(ref: Gray, cur: Gray): PoseDelta | null {
  const a = litBox(ref);
  const b = litBox(cur);
  if (!a || !b) return null;
  const cx = (a.x0 + a.x1) / 2;
  const cy = (a.y0 + a.y1) / 2;
  const s0 = (b.x1 - b.x0 + (b.y1 - b.y0)) / (a.x1 - a.x0 + (a.y1 - a.y0));
  const ox = (b.x0 + b.x1) / 2 - cx;
  const oy = (b.y0 + b.y1) / 2 - cy;
  // The strongest edges of the reference inside its tray box (padded).
  const pts: { x: number; y: number; w: number }[] = [];
  const pad = 12;
  for (let y = Math.max(1, a.y0 - pad); y < Math.min(ref.height - 1, a.y1 + pad); y += 1) {
    for (let x = Math.max(1, a.x0 - pad); x < Math.min(ref.width - 1, a.x1 + pad); x += 1) {
      const w = ref.grad[y * ref.width + x] ?? 0;
      if (w >= 40) pts.push({ x, y, w });
    }
  }
  pts.sort((p, q) => q.w - p.w);
  const sample = pts.filter((_, i) => i % Math.max(1, Math.floor(pts.length / 1500)) === 0);
  const total = sample.reduce((s, p) => s + p.w, 0) || 1;
  const at = (g: Gray, x: number, y: number): number => {
    const xi = Math.round(x);
    const yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= g.width || yi >= g.height) return 0;
    return g.grad[yi * g.width + xi] ?? 0;
  };
  let best = { score: -1, s: s0, r: 0, dx: ox, dy: oy };
  const search = (ss: number[], rs: number[], dxs: number[], dys: number[]): void => {
    for (const s of ss)
      for (const r of rs) {
        const c = Math.cos((r * Math.PI) / 180);
        const n = Math.sin((r * Math.PI) / 180);
        for (const dx of dxs)
          for (const dy of dys) {
            let score = 0;
            for (const p of sample) {
              const u = p.x - cx;
              const v = p.y - cy;
              score += Math.min(
                p.w,
                at(cur, cx + dx + s * (c * u - n * v), cy + dy + s * (n * u + c * v)),
              );
            }
            if (score > best.score) best = { score, s, r, dx, dy };
          }
      }
  };
  // Coarse, then fine around the coarse best.
  search(range(s0, 0.04, 0.01), range(0, 2, 0.5), range(ox, 8, 2), range(oy, 8, 2));
  const coarse = { ...best };
  search(
    range(coarse.s, 0.01, 0.0025),
    range(coarse.r, 0.5, 0.125),
    range(coarse.dx, 2, 0.5),
    range(coarse.dy, 2, 0.5),
  );
  const c = Math.cos((best.r * Math.PI) / 180);
  const n = Math.sin((best.r * Math.PI) / 180);
  const corners: [number, number][] = [
    [a.x0, a.y0],
    [a.x1, a.y0],
    [a.x0, a.y1],
    [a.x1, a.y1],
  ];
  const corner = Math.max(
    ...corners.map(([x, y]) => {
      const u = x - cx;
      const v = y - cy;
      const X = cx + best.dx + best.s * (c * u - n * v);
      const Y = cy + best.dy + best.s * (n * u + c * v);
      return Math.hypot(X - x, Y - y);
    }),
  );
  return {
    corner,
    tilt: Math.abs(best.r),
    scale: best.s,
    dx: best.dx,
    dy: best.dy,
    match: best.score / total,
    ref: a,
    box: b,
  };
}
