/**
 * The single scroll timeline shared by the scene and the page (design.md §3).
 *
 * Scroll progress `p` runs 0 → 1 over the page. The scene rests on key state `k` during
 * `HOLDS[k]` and morphs from `HOLDS[k][1]` to `HOLDS[k + 1][0]`; every morph straddles a DOM
 * section boundary. Pure data and pure functions: no DOM, no three.js.
 */

export const SECTION_IDS = ["hello", "journey", "work", "services", "process", "contact"] as const;
export type SectionId = (typeof SECTION_IDS)[number];

export interface SectionRange {
  id: SectionId;
  label: string;
  /** Start of the section's DOM range in `p`. */
  start: number;
  /** End of the section's DOM range in `p`. */
  end: number;
}

export const SECTIONS: readonly SectionRange[] = [
  { id: "hello", label: "Hello", start: 0, end: 0.12 },
  { id: "journey", label: "Journey", start: 0.12, end: 0.3 },
  { id: "work", label: "Work", start: 0.3, end: 0.52 },
  { id: "services", label: "Services", start: 0.52, end: 0.68 },
  { id: "process", label: "Process", start: 0.68, end: 0.84 },
  { id: "contact", label: "Contact", start: 0.84, end: 1 },
];

/** `[start, end]` of each hold, where the scene rests on key state k. */
export const HOLDS: readonly (readonly [number, number])[] = [
  [0, 0.06],
  [0.17, 0.25],
  [0.36, 0.46],
  [0.57, 0.63],
  [0.73, 0.79],
  [0.92, 1],
];

export const KEY_COUNT = HOLDS.length;

/** A sub-window `[a, b]` of a morph's local time t. */
export type Window = readonly [number, number];

export type Track = "cam" | "tiles" | "ves" | "lamp" | "light" | "tex" | "liq";

/** Who leads each morph: per-track sub-windows, one per morph M1…M5 (design.md §3). */
export const TIMING: Readonly<Record<Track, readonly Window[]>> = {
  cam: [
    [0, 1],
    [0, 1],
    [0, 1],
    [0, 1],
    [0, 1],
  ],
  tiles: [
    [0, 0.85],
    [0.18, 0.9],
    [0.15, 1],
    [0, 1],
    // Prints start sliding only once they have risen clear of the tray walls (M2-AC5).
    [0.28, 0.8],
  ],
  ves: [
    [0, 1],
    [0.1, 0.9],
    [0, 0.75],
    [0, 0.75],
    [0.2, 0.8],
  ],
  lamp: [
    [0.1, 0.9],
    [0.1, 1],
    [0, 0.9],
    [0.1, 0.9],
    [0.2, 1],
  ],
  light: [
    [0, 1],
    [0, 1],
    [0, 1],
    [0, 1],
    [0.3, 1],
  ],
  tex: [
    [0.3, 0.7],
    [0.35, 0.75],
    [0.35, 0.7],
    [0.3, 0.7],
    [0.35, 0.7],
  ],
  // The bath drains before prints leave it and refills only after they land.
  liq: [
    [0, 1],
    [0, 0.2],
    [0, 1],
    [0.85, 1],
    [0, 0.12],
  ],
};

export const clamp = (x: number, min = 0, max = 1): number => Math.min(max, Math.max(min, x));

/** easeInOutCubic ≈ cubic-bezier(.65, 0, .35, 1), the `--ease-inout` token. */
export const ease = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/** Eased progress through the sub-window `[a, b]` of a morph's local time `t`. */
export const windowed = (t: number, [a, b]: Window): number => ease(clamp((t - a) / (b - a)));

export interface Location {
  /** Key state index (during a hold) or the morph from k to k + 1. */
  k: number;
  /** Local morph time in (0, 1); 0 during a hold. */
  t: number;
}

/** Where `p` sits on the timeline. */
export function locate(p: number): Location {
  for (let k = 0; k < KEY_COUNT; k += 1) {
    const hold = HOLDS[k];
    if (!hold) break;
    const [a, b] = hold;
    if (p >= a && p <= b) return { k, t: 0 };
    const next = HOLDS[k + 1];
    if (next && p > b && p < next[0]) return { k, t: (p - b) / (next[0] - b) };
  }
  return { k: KEY_COUNT - 1, t: 0 };
}

/** Index of the DOM section that contains `p`. */
export function sectionAt(p: number): number {
  const index = SECTIONS.findIndex((section) => p < section.end);
  return index === -1 ? SECTIONS.length - 1 : index;
}

/** The scroll progress at which each key frame is shown in the mockups (kf-01…kf-06). */
export const KEY_PROGRESS: readonly number[] = [0.03, 0.21, 0.41, 0.6, 0.76, 0.96];

/* ---------- Copy layer (design.md §5) ---------- */

/** Fractions of a morph's local time: outgoing copy exits over [0, .35], incoming enters over [.65, 1]. */
export const COPY_EXIT_END = 0.35;
export const COPY_ENTER_START = 0.65;
/** Vertical travel of the copy while it exits (up) or enters (from below), in CSS px. */
export const COPY_TRAVEL_PX = 24;

export interface CopyState {
  /** Opacity 0 → 1. */
  opacity: number;
  /** translateY in px (negative = up). */
  y: number;
}

/**
 * Opacity and offset of section `index`'s copy at progress `p`: at rest during its hold, exits
 * over the first 35 % of the next morph, enters over the last 35 % of the previous one, and is
 * absent otherwise. At most one section has opacity > 0 at any p.
 */
export function copyState(p: number, index: number): CopyState {
  const { k, t } = locate(clamp(p));
  if (t === 0) return k === index ? { opacity: 1, y: 0 } : { opacity: 0, y: 0 };
  if (k === index && t <= COPY_EXIT_END) {
    const opacity = 1 - ease(t / COPY_EXIT_END);
    return { opacity, y: -COPY_TRAVEL_PX * (1 - opacity) };
  }
  if (k + 1 === index && t >= COPY_ENTER_START) {
    const opacity = ease((t - COPY_ENTER_START) / (1 - COPY_ENTER_START));
    return { opacity, y: COPY_TRAVEL_PX * (1 - opacity) };
  }
  return { opacity: 0, y: 0 };
}

/** `[from, to]` in p over which section `index`'s copy is at least partly visible. */
export function copyWindow(index: number): readonly [number, number] {
  const hold = HOLDS[index];
  if (!hold) throw new Error(`No hold ${index}`);
  const prev = HOLDS[index - 1];
  const next = HOLDS[index + 1];
  const from = prev ? prev[1] + (hold[0] - prev[1]) * COPY_ENTER_START : 0;
  const to = next ? hold[1] + (next[0] - hold[1]) * COPY_EXIT_END : 1;
  return [from, to];
}

/**
 * Which of `count` beats (cards stepped through while a section is pinned) is active at `p`:
 * the section's copy window split into equal parts.
 */
export function beatAt(p: number, index: number, count: number): number {
  if (count <= 1) return 0;
  const [from, to] = copyWindow(index);
  return Math.min(count - 1, Math.max(0, Math.floor(((p - from) / (to - from)) * count)));
}

/** The p at the middle of beat `beat` of section `index` (where focus scrolls to). */
export function beatProgress(index: number, beat: number, count: number): number {
  if (count <= 1) return KEY_PROGRESS[index] ?? 0;
  const [from, to] = copyWindow(index);
  return from + ((beat + 0.5) / count) * (to - from);
}

/** Crossfade width (in p) between two beats: ≤ .035, and never more than 60 % of a beat. */
export function beatFade(index: number, count: number): number {
  const [from, to] = copyWindow(index);
  return Math.min(0.035, (0.6 * (to - from)) / Math.max(1, count));
}

/**
 * Opacity of beat `beat` (of `count`) of section `index` at `p`, scrubbed by scroll like the rest
 * of the copy: 1 inside its share of the copy window, crossfading with its neighbour (linear in
 * p, centred on the boundary, the two always sum to 1). Linear keeps the per-frame change as
 * small as possible; time-based or eased transitions concentrate it and show up as pops in the
 * per-p smoothness capture (M2-AC6).
 */
export function beatOpacity(p: number, index: number, beat: number, count: number): number {
  if (count <= 1) return 1;
  const [from, to] = copyWindow(index);
  const share = (to - from) / count;
  const fade = beatFade(index, count);
  const ramp = (boundary: number): number => clamp((p - (boundary - fade / 2)) / fade);
  const rise = beat === 0 ? 1 : ramp(from + beat * share);
  const fall = beat === count - 1 ? 1 : 1 - ramp(from + (beat + 1) * share);
  return rise * fall;
}
