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
