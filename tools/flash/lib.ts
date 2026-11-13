/**
 * Pure maths for the motion-safety (flash) check, M3-AC10. No I/O, unit-tested in
 * tests/unit/flash.test.ts.
 *
 * Definitions follow WCAG 2.2 "general flash and red flash thresholds":
 * - a **general transition** is a change in relative luminance of ≥ 0.1 where the darker of
 *   the two states is < 0.8;
 * - a **red transition** is a change of > 20 in "saturated red" (R − G − B) × 320 on pixels where
 *   R / (R + G + B) ≥ 0.8 (linearised 0–1 channels, as in the relative-luminance definition);
 * - a **flash** is a pair of opposing transitions, so the flash count in a window is
 *   transitions / 2;
 * - the bar is **no more than 3 flashes in any 1-second period**, per region.
 * Transitions use hysteresis from the last turning point, so slow drifts that add up to 0.1 count
 * once, and noise below the threshold never counts.
 */

export const GENERAL_DELTA = 0.1;
export const GENERAL_DARK_MAX = 0.8;
export const RED_DELTA = 20;
export const RED_RATIO = 0.8;
export const MAX_FLASHES_PER_SECOND = 3;

/** sRGB channel 0–255 → linear 0–1. */
export function linear(channel: number): number {
  const c = channel / 255;
  return c <= 0.040_45 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

const LINEAR = Float64Array.from({ length: 256 }, (_, i) => linear(i));

/** WCAG relative luminance of one sRGB pixel. */
export function luminance(r: number, g: number, b: number): number {
  return 0.2126 * (LINEAR[r] ?? 0) + 0.7152 * (LINEAR[g] ?? 0) + 0.0722 * (LINEAR[b] ?? 0);
}

/** WCAG "saturated red" value of one sRGB pixel (0 unless R / (R + G + B) ≥ 0.8). */
export function saturatedRed(r: number, g: number, b: number): number {
  // WCAG: R, G and B "range from 0-1 as specified in the relative luminance definition", i.e.
  // the linearised channels.
  const lr = LINEAR[r] ?? 0;
  const lg = LINEAR[g] ?? 0;
  const lb = LINEAR[b] ?? 0;
  const sum = lr + lg + lb;
  if (sum === 0 || lr / sum < RED_RATIO) return 0;
  return Math.max(0, (lr - lg - lb) * 320);
}

export interface Grid {
  cols: number;
  rows: number;
}

export interface RegionFrame {
  /** Mean relative luminance per region, row-major. */
  luminance: Float64Array;
  /** Mean saturated-red value per region, row-major. */
  red: Float64Array;
}

/**
 * Mean luminance and saturated red per grid cell of one RGB(A) frame. Pixels are averaged in
 * linear light (luminance) as WCAG's area rule intends.
 */
export function regionMeans(
  data: Uint8Array | Buffer,
  width: number,
  height: number,
  channels: number,
  grid: Grid,
): RegionFrame {
  const n = grid.cols * grid.rows;
  const lum = new Float64Array(n);
  const red = new Float64Array(n);
  const count = new Float64Array(n);
  for (let y = 0; y < height; y += 1) {
    const row = Math.min(grid.rows - 1, Math.floor((y * grid.rows) / height)) * grid.cols;
    for (let x = 0; x < width; x += 1) {
      const cell = row + Math.min(grid.cols - 1, Math.floor((x * grid.cols) / width));
      const i = (y * width + x) * channels;
      const r = data[i] ?? 0;
      const g = data[i + 1] ?? 0;
      const b = data[i + 2] ?? 0;
      lum[cell] = (lum[cell] ?? 0) + luminance(r, g, b);
      red[cell] = (red[cell] ?? 0) + saturatedRed(r, g, b);
      count[cell] = (count[cell] ?? 0) + 1;
    }
  }
  for (let c = 0; c < n; c += 1) {
    const k = Math.max(1, count[c] ?? 0);
    lum[c] = (lum[c] ?? 0) / k;
    red[c] = (red[c] ?? 0) / k;
  }
  return { luminance: lum, red };
}

export type Kind = "general" | "red";

/**
 * Frame indices at which a transition completes in one region's series. A transition is a move
 * of ≥ `delta` (general: and the darker end < 0.8) away from the last turning point, opposite in
 * direction to the previous transition.
 */
export function transitions(series: ArrayLike<number>, kind: Kind): number[] {
  const out: number[] = [];
  if (series.length === 0) return out;
  const delta = kind === "general" ? GENERAL_DELTA : RED_DELTA;
  const counts = (from: number, to: number): boolean => {
    const change = Math.abs(to - from);
    if (kind === "red") return change > delta;
    return change >= delta && Math.min(from, to) < GENERAL_DARK_MAX;
  };
  let hi = series[0] ?? 0;
  let lo = hi;
  /** +1 after a rising transition, −1 after a falling one, 0 before the first. */
  let dir = 0;
  for (let i = 1; i < series.length; i += 1) {
    const v = series[i] ?? 0;
    if (dir >= 0) hi = Math.max(hi, v);
    if (dir <= 0) lo = Math.min(lo, v);
    if (dir !== -1 && counts(hi, v) && v < hi) {
      out.push(i);
      dir = -1;
      lo = v;
    } else if (dir !== 1 && counts(lo, v) && v > lo) {
      out.push(i);
      dir = 1;
      hi = v;
    }
  }
  return out;
}

/**
 * Most transitions whose frame times fall in any window of `span` (same unit as `times`).
 * Order-independent: the times are sorted first (reverse-scroll transition lists arrive in
 * descending frame order; unsorted input used to count every transition as one window).
 */
export function maxInWindow(input: readonly number[], span: number): number {
  const times = input.toSorted((a, b) => a - b);
  let best = 0;
  let start = 0;
  for (let end = 0; end < times.length; end += 1) {
    while ((times[end] ?? 0) - (times[start] ?? 0) >= span) start += 1;
    best = Math.max(best, end - start + 1);
  }
  return best;
}

/** Flashes in the worst 1 s window when frame i is shown at `timeOf(i)` seconds. */
export function worstFlashesPerSecond(
  frames: readonly number[],
  timeOf: (frame: number) => number,
): number {
  return maxInWindow(frames.map(timeOf), 1) / 2;
}

/**
 * Shortest full-page scroll (seconds, at a constant rate over `frameCount` frames) for which
 * the worst region stays at ≤ 3 flashes per second. 0 if the series never flashes at all.
 */
export function minSafeSeconds(
  perRegion: readonly (readonly number[])[],
  frameCount: number,
): number {
  const ok = (seconds: number): boolean =>
    perRegion.every(
      (frames) =>
        worstFlashesPerSecond(frames, (i) => (i / (frameCount - 1)) * seconds) <=
        MAX_FLASHES_PER_SECOND,
    );
  if (ok(1e-6)) return 0;
  let lo = 1e-6;
  let hi = 1;
  while (!ok(hi)) hi *= 2;
  for (let step = 0; step < 40; step += 1) {
    const mid = (lo + hi) / 2;
    if (ok(mid)) hi = mid;
    else lo = mid;
  }
  return hi;
}

/** p span of a ramp: from the first sample above `lowFrac` of the way to the last above `highFrac`. */
export function rampSpan(
  ps: readonly number[],
  values: readonly number[],
  lowFrac: number,
  highFrac: number,
): { from: number; to: number; span: number } {
  const first = values[0] ?? 0;
  const last = values.at(-1) ?? 0;
  const at = (frac: number): number => {
    const level = first + (last - first) * frac;
    const rising = last >= first;
    const i = values.findIndex((v) => (rising ? v >= level : v <= level));
    return ps[Math.max(0, i)] ?? 0;
  };
  // Exactly 0 / 1 ends would pick the first sample: use the last sample still at the start value.
  const fromIndex = lowFrac === 0 ? Math.max(0, values.findIndex((v) => v !== first) - 1) : -1;
  const from = fromIndex >= 0 ? (ps[fromIndex] ?? 0) : at(lowFrac);
  const to = at(highFrac);
  return { from, to, span: to - from };
}

/** One frame of the stage's scroll catch-up (src/_pages/home/lib/catch-up.ts `catchUpStep`). */
export type CatchUpStepFn = (
  shown: number,
  target: number,
  dt: number,
  clock: { sinceCut: number; sinceSweep: number },
) => { shown: number; cut: boolean; swept: boolean };

/** What the screen shows at time `t` (s): progress `p`, reached by a cut or by a sweep. */
export interface ShownSample {
  t: number;
  p: number;
  cut: boolean;
}

/**
 * Replays the stage's render loop (stage.ts `tick`) for one input: the scene starts at `p0`, the
 * scroll target follows `target(t)` from t = 0 (input lasts until `inputEnd` s), frames run at `fps`, and, as in the stage, the
 * scene snaps to the target (a cut) once `snapSeconds` after the last input would be overrun,
 * or settles within `epsilon`. Returns the shown progress per frame, starting at t = 0.
 */
export function replayCatchUp(
  step: CatchUpStepFn,
  p0: number,
  target: (t: number) => number,
  inputEnd: number,
  {
    fps = 60,
    snapSeconds,
    epsilon = 1e-4,
  }: { fps?: number; snapSeconds: number; epsilon?: number },
): ShownSample[] {
  const dt = 1 / fps;
  let shown = p0;
  let lastCut = Number.NEGATIVE_INFINITY;
  let lastSweep = Number.NEGATIVE_INFINITY;
  const out: ShownSample[] = [{ t: 0, p: shown, cut: false }];
  for (let k = 1; k < fps * (inputEnd + snapSeconds + 1); k += 1) {
    const t = k * dt;
    const goal = target(t);
    const next = step(shown, goal, dt, { sinceCut: t - lastCut, sinceSweep: t - lastSweep });
    let { cut } = next;
    shown = next.shown;
    const settled =
      Math.abs(goal - shown) < epsilon || t - Math.min(t, inputEnd) + 3 * dt >= snapSeconds;
    if (settled && shown !== goal) {
      cut ||= Math.abs(goal - shown) >= epsilon;
      shown = goal;
    }
    if (cut) lastCut = t;
    if (next.swept) lastSweep = t;
    out.push({ t, p: shown, cut });
    if (settled && t >= inputEnd) break;
  }
  return out;
}

/**
 * Expands replayed frames into the states the scene passes through: a sweep from one frame to the
 * next is assumed to show every captured frame in between (strict: a real 60 Hz screen skips
 * some), at linearly interpolated times; a cut shows only its end state.
 */
export function sweepStates(
  shown: readonly ShownSample[],
  frameCount: number,
): { t: number; p: number }[] {
  const first = shown[0];
  if (!first) return [];
  const out = [{ t: first.t, p: first.p }];
  for (let k = 1; k < shown.length; k += 1) {
    const a = shown[k - 1] ?? first;
    const b = shown[k] ?? first;
    if (!b.cut && b.p !== a.p) {
      const up = b.p > a.p;
      const ia = a.p * (frameCount - 1);
      const ib = b.p * (frameCount - 1);
      const from = up ? Math.floor(ia) + 1 : Math.ceil(ia) - 1;
      for (let i = from; up ? i < ib : i > ib; i += up ? 1 : -1) {
        const p = i / (frameCount - 1);
        out.push({ t: a.t + ((p - a.p) / (b.p - a.p)) * (b.t - a.t), p });
      }
    }
    out.push({ t: b.t, p: b.p });
  }
  return out;
}

/** A region's value at progress p, linearly interpolated between captured frames (p = i / (n − 1)). */
export function valueAt(series: ArrayLike<number>, p: number): number {
  const x = Math.max(0, Math.min(1, p)) * (series.length - 1);
  const i = Math.floor(x);
  const a = series[i] ?? 0;
  const b = series[Math.min(series.length - 1, i + 1)] ?? a;
  return a + (b - a) * (x - i);
}

/** Worst flashes in any 1 s for one region's series shown along `states` (from sweepStates). */
export function pathFlashesPerSecond(
  series: ArrayLike<number>,
  states: readonly { t: number; p: number }[],
  kind: Kind,
): number {
  const values = states.map((s) => valueAt(series, s.p));
  return worstFlashesPerSecond(transitions(values, kind), (i) => states[i]?.t ?? 0);
}
