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
    return [{ index, body, beats, beatCount, lastOpacity: -1, lastBeat: -1 }];
  });
}

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
      if (section.beatCount > 1 && opacity > 0) {
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

  // Keyboard users: focus inside copy that is not on screen scrolls to where it is shown.
  const onFocusIn = (event: FocusEvent): void => {
    const { target } = event;
    if (!query.matches || !(target instanceof Element)) return;
    const section = sections.find((s) => s.body.contains(target));
    if (!section) return;
    const beatEl = section.beats.find((b) => b.el.contains(target));
    const firstBeat = beatEl?.beats[0];
    const targetBeat =
      section.beatCount > 1 && firstBeat !== undefined
        ? firstBeat
        : beatAt(current, section.index, section.beatCount);
    const visible = copyState(current, section.index).opacity >= 0.99;
    const onBeat =
      section.beatCount <= 1 || beatAt(current, section.index, section.beatCount) === targetBeat;
    if (visible && onBeat) return;
    window.scrollTo({
      top: progressToScroll(beatProgress(section.index, targetBeat, section.beatCount)),
      behavior: "instant",
    });
  };

  query.addEventListener("change", applyMode);
  document.addEventListener("focusin", onFocusIn);
  applyMode();

  return {
    update,
    pinned: () => query.matches,
    dispose: () => {
      query.removeEventListener("change", applyMode);
      document.removeEventListener("focusin", onFocusIn);
      delete root.dataset.pin;
      reset();
    },
  };
}
