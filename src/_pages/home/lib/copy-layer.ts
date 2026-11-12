/**
 * The pinned, scroll-scrubbed copy layer of the full tier (design.md §5, build plan M2-AC8).
 *
 * While the 3D scene runs on a large enough viewport, each section's copy is pinned over the
 * scene (`html[data-pin="on"]`, see HomeSection.astro) and its opacity / offset follow the same
 * hold/morph table as the scene (`copyState` in @shared/lib/timeline): at rest during its hold,
 * out over the first 35 % of the next morph, in over the last 35 % of the previous one, nothing
 * in between. Sections whose copy is longer than one screen step through "beats".
 *
 * The copy is never `display:none` or `visibility:hidden`; it stays in the accessibility tree,
 * and focus inside a section scrolls the page to where that copy is shown.
 */
import {
  beatAt,
  beatOpacity,
  beatProgress,
  clamp,
  copyState,
  HOLDS,
  SECTIONS,
} from "@shared/lib/timeline";

/** Viewports where every section's pinned layout fits (smaller ones keep normal flow). */
export const PIN_QUERY = "(min-width: 1200px) and (min-height: 760px)";

interface SectionCopy {
  index: number;
  body: HTMLElement;
  beats: { el: HTMLElement; beats: number[] }[];
  beatCount: number;
  lastOpacity: number;
  lastBeat: number;
  /** Beat that holds keyboard focus; it is shown instead of the scroll-picked beat. */
  focusBeat: number | null;
}

export interface CopyLayer {
  /** Apply the copy state for progress p (called with the scene's own, smoothed p). */
  update: (p: number) => void;
  /** Whether the pinned layout is on. */
  pinned: () => boolean;
  dispose: () => void;
}

const root = document.documentElement;

function collect(): SectionCopy[] {
  return SECTIONS.flatMap((section, index): SectionCopy[] => {
    const body = document.querySelector<HTMLElement>(`#${section.id} [data-copy-body]`);
    if (!body) return [];
    const beats = Array.from(body.querySelectorAll<HTMLElement>("[data-beat]")).map((el) => ({
      el,
      beats: (el.dataset.beat ?? "").split(/\s+/u).filter(Boolean).map(Number),
    }));
    const beatCount = beats.reduce(
      (max, item) => Math.max(max, ...item.beats.map((b) => b + 1)),
      1,
    );
    return [{ index, body, beats, beatCount, lastOpacity: -1, lastBeat: -1, focusBeat: null }];
  });
}

/** Inset from the hold edges for focus targets, so the scene is fully at rest there. */
const HOLD_INSET = 0.002;

/**
 * Where focus inside section `index` scrolls to: the beat's own position, clamped into the
 * section's hold, so focused copy never sits over a morph in progress (QA B-5).
 */
export function focusProgress(index: number, beat: number, count: number): number {
  const hold = HOLDS[index];
  const p = beatProgress(index, beat, count);
  if (!hold) return p;
  return clamp(p, hold[0] + HOLD_INSET, hold[1] - HOLD_INSET);
}

const inHold = (p: number, index: number): boolean => {
  const hold = HOLDS[index];
  return hold !== undefined && p >= hold[0] && p <= hold[1];
};

const scrollProgress = (): number => {
  const max = document.documentElement.scrollHeight - window.innerHeight;
  return max > 0 ? clamp(window.scrollY / max) : 0;
};

const progressToScroll = (p: number): number =>
  clamp(p) * Math.max(0, document.documentElement.scrollHeight - window.innerHeight);

export function createCopyLayer(): CopyLayer {
  const sections = collect();
  const query = window.matchMedia(PIN_QUERY);
  const bar = document.querySelector<HTMLElement>("[data-progress]");
  const footer = document.querySelector<HTMLElement>("[data-site-footer]");
  const last = sections.at(-1);
  let current = 0;

  const reset = (): void => {
    for (const section of sections) {
      section.body.style.removeProperty("--copy-o");
      section.body.style.removeProperty("--copy-y");
      section.body.removeAttribute("data-copy-active");
      for (const { el } of section.beats) {
        el.removeAttribute("data-beat-active");
        el.style.removeProperty("--beat-o");
      }
      section.lastOpacity = -1;
      section.lastBeat = -1;
    }
    bar?.style.removeProperty("transform");
    footer?.style.removeProperty("--footer-o");
    footer?.removeAttribute("data-footer-active");
  };

  const update = (p: number): void => {
    current = p;
    if (!query.matches) return;
    if (bar) bar.style.transform = `scaleX(${clamp(p).toFixed(4)})`;
    if (footer && last) {
      const { opacity } = copyState(p, last.index);
      footer.style.setProperty("--footer-o", opacity.toFixed(4));
      footer.toggleAttribute("data-footer-active", opacity > 0.01);
    }
    for (const section of sections) {
      const { opacity, y } = copyState(p, section.index);
      if (opacity !== section.lastOpacity) {
        section.lastOpacity = opacity;
        section.body.style.setProperty("--copy-o", opacity.toFixed(4));
        section.body.style.setProperty("--copy-y", `${y.toFixed(2)}px`);
        section.body.toggleAttribute("data-copy-active", opacity > 0.01);
      }
      if (section.beatCount > 1 && opacity > 0 && section.focusBeat !== null) {
        // Focus picked the beat: show it alone (scroll still scrubs the section as a whole).
        const focused = section.focusBeat;
        for (const item of section.beats) {
          const on = item.beats.includes(focused);
          item.el.style.setProperty("--beat-o", on ? "1" : "0");
          item.el.toggleAttribute("data-beat-active", on);
        }
        section.lastBeat = -1;
      } else if (section.beatCount > 1 && opacity > 0) {
        for (const item of section.beats) {
          // An element in several beats (e.g. a list shown across two) stays opaque through
          // the crossfade between them: neighbouring weights sum to 1.
          const o = Math.min(
            1,
            item.beats.reduce(
              (sum, b) => sum + beatOpacity(p, section.index, b, section.beatCount),
              0,
            ),
          );
          item.el.style.setProperty("--beat-o", o.toFixed(4));
        }
        const beat = beatAt(p, section.index, section.beatCount);
        if (beat !== section.lastBeat) {
          section.lastBeat = beat;
          for (const item of section.beats) {
            item.el.toggleAttribute("data-beat-active", item.beats.includes(beat));
          }
        }
      }
    }
  };

  const applyMode = (): void => {
    if (query.matches) {
      root.dataset.pin = "on";
      update(current);
    } else {
      delete root.dataset.pin;
      reset();
    }
  };

  // Keyboard users: focus inside copy that is not on screen scrolls to where it is shown, always
  // inside the section's hold (the scene at rest), and the focused beat is the one shown.
  const onFocusIn = (event: FocusEvent): void => {
    const { target } = event;
    if (!query.matches || !(target instanceof Element)) return;
    for (const s of sections) s.focusBeat = null;
    const section = sections.find((s) => s.body.contains(target));
    if (!section) {
      update(current);
      return;
    }
    const beatEl = section.beats.find((b) => b.el.contains(target));
    const ownBeat = section.beatCount > 1 ? beatEl?.beats[0] : undefined;
    const targetBeat = ownBeat ?? beatAt(current, section.index, section.beatCount);
    if (ownBeat !== undefined) section.focusBeat = ownBeat;
    const scrolled = scrollProgress();
    if (!inHold(scrolled, section.index)) {
      window.scrollTo({
        top: progressToScroll(focusProgress(section.index, targetBeat, section.beatCount)),
        behavior: "instant",
      });
    }
    update(current);
  };

  const onFocusOut = (event: FocusEvent): void => {
    const next = event.relatedTarget;
    if (next instanceof Element && sections.some((s) => s.body.contains(next))) return;
    for (const s of sections) s.focusBeat = null;
    update(current);
  };
  query.addEventListener("change", applyMode);
  document.addEventListener("focusin", onFocusIn);
  document.addEventListener("focusout", onFocusOut);
  applyMode();

  return {
    update,
    pinned: () => query.matches,
    dispose: () => {
      query.removeEventListener("change", applyMode);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
      delete root.dataset.pin;
      reset();
    },
  };
}
