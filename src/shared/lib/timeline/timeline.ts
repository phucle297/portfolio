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
    [0, 0.65],
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
    [0, 0.3],
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

/** Stretch of the hold (in p) over which each card is fully shown, when the hold is short. */
const BEAT_SHOWN = 0.0035;
/** Longest crossfade between two beats, in p. */
const BEAT_FADE_MAX = 0.035;

interface BeatLayout {
  /** p where beat j − 1 hands over to beat j (middle of their crossfade), for j = 1 … count − 1. */
  boundaries: number[];
  /** Crossfade width in p. */
  fade: number;
}

/**
 * Beats (cards stepped through while a section is pinned) are laid out inside the section's
 * hold, so every card is fully shown while the scene is at rest, never only during a morph
 * (QA B-7). Each beat gets the same fully-shown stretch of the hold, `shown`: the first one
 * from the hold start, the last one up to the hold end, the middle ones between two crossfades.
 * The rest of the hold goes to the crossfades, as long as possible (a slow linear crossfade
 * keeps the per-frame change small, M2-AC6): H = count·shown + (count − 1)·fade, with fade
 * capped at .035 (longer holds give each card a longer stretch instead).
 * Outside the hold the first beat stays on while the copy enters and the last while it exits.
 */
function beatLayout(index: number, count: number): BeatLayout {
  const hold = HOLDS[index];
  if (!hold) throw new Error(`No hold ${index}`);
  const [from, to] = hold;
  const fade = Math.min(BEAT_FADE_MAX, (to - from - count * BEAT_SHOWN) / (count - 1));
  if (fade <= 0) throw new Error(`Hold ${index} is too short for ${count} beats`);
  const step = (to - from + fade) / count;
  const first = from + step - fade / 2;
  return { boundaries: Array.from({ length: count - 1 }, (_, j) => first + j * step), fade };
}

/** Which of `count` beats is active at `p` (the one past its last handover). */
export function beatAt(p: number, index: number, count: number): number {
  if (count <= 1) return 0;
  return beatLayout(index, count).boundaries.filter((b) => p >= b).length;
}

/** The p in the middle of beat `beat`'s fully-shown stretch of the hold (where focus scrolls to). */
export function beatProgress(index: number, beat: number, count: number): number {
  if (count <= 1) return KEY_PROGRESS[index] ?? 0;
  const hold = HOLDS[index];
  if (!hold) throw new Error(`No hold ${index}`);
  const { boundaries, fade } = beatLayout(index, count);
  const start = beat === 0 ? hold[0] : (boundaries[beat - 1] ?? hold[0]) + fade / 2;
  const end = beat === count - 1 ? hold[1] : (boundaries[beat] ?? hold[1]) - fade / 2;
  return (start + end) / 2;
}

/** Crossfade width (in p) between two beats of section `index`. */
export function beatFade(index: number, count: number): number {
  return count <= 1 ? 0 : beatLayout(index, count).fade;
}

/**
 * Opacity of beat `beat` (of `count`) of section `index` at `p`, scrubbed by scroll like the rest
 * of the copy: 1 on its own stretch, crossfading with its neighbour (linear in p, centred on the
 * handover, the two always sum to 1). Linear keeps the per-frame change as small as possible;
 * time-based or eased transitions concentrate it and show up as pops in the per-p smoothness
 * capture (M2-AC6).
 */
export function beatOpacity(p: number, index: number, beat: number, count: number): number {
  if (count <= 1) return 1;
  const { boundaries, fade } = beatLayout(index, count);
  const ramp = (boundary: number): number => clamp((p - (boundary - fade / 2)) / fade);
  const rise = beat === 0 ? 1 : ramp(boundaries[beat - 1] ?? 0);
  const fall = beat === count - 1 ? 1 : 1 - ramp(boundaries[beat] ?? 1);
  return rise * fall;
}
