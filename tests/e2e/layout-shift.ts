import type { Page } from "@playwright/test";

/** One rect of a layout-shift source, rounded to whole CSS px. */
export interface ShiftRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One node a layout shift moved: a short selector path plus its rect before and after. */
export interface ShiftSource {
  node: string;
  text: string;
  previousRect: ShiftRect;
  currentRect: ShiftRect;
}

/** One `layout-shift` entry with the page state at the time it was reported. */
export interface ShiftRecord {
  startTime: number;
  value: number;
  hadRecentInput: boolean;
  scrollY: number;
  pin: string | null;
  tier: string | null;
  sources: ShiftSource[];
}

declare global {
  interface Window {
    layoutShifts?: ShiftRecord[];
  }
}

/**
 * Records every `layout-shift` entry (buffered, so shifts before the observer attached count too)
 * with its sources' node paths and rects into `window.layoutShifts`. Call before `page.goto`.
 */
export async function recordLayoutShifts(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const shifts: ShiftRecord[] = [];
    window.layoutShifts = shifts;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const value = "value" in entry && typeof entry.value === "number" ? entry.value : 0;
        const input = "hadRecentInput" in entry && entry.hadRecentInput === true;
        const raw: unknown[] =
          "sources" in entry && Array.isArray(entry.sources) ? entry.sources : [];
        const sources: ShiftSource[] = [];
        for (const source of raw) {
          if (typeof source !== "object" || source === null) continue;
          const node = "node" in source && source.node instanceof Node ? source.node : null;
          const rects = [
            "previousRect" in source ? source.previousRect : null,
            "currentRect" in source ? source.currentRect : null,
          ].map((rect) =>
            rect instanceof DOMRectReadOnly
              ? {
                  x: Math.round(rect.x),
                  y: Math.round(rect.y),
                  width: Math.round(rect.width),
                  height: Math.round(rect.height),
                }
              : { x: 0, y: 0, width: 0, height: 0 },
          );
          const path: string[] = [];
          let el: Element | null = node instanceof Element ? node : (node?.parentElement ?? null);
          for (let depth = 0; el !== null && depth < 4; depth += 1) {
            const classes =
              typeof el.className === "string"
                ? el.className.trim().split(/\s+/u).filter(Boolean)
                : [];
            const id = el.id === "" ? "" : `#${el.id}`;
            path.unshift(`${el.tagName.toLowerCase()}${id}${classes.map((c) => `.${c}`).join("")}`);
            el = el.parentElement;
          }
          sources.push({
            node: path.length > 0 ? path.join(" > ") : (node?.nodeName ?? "(removed)"),
            text: (node?.textContent ?? "").trim().slice(0, 40),
            previousRect: rects[0] ?? { x: 0, y: 0, width: 0, height: 0 },
            currentRect: rects[1] ?? { x: 0, y: 0, width: 0, height: 0 },
          });
        }
        shifts.push({
          startTime: Math.round(entry.startTime),
          value,
          hadRecentInput: input,
          scrollY: Math.round(window.scrollY),
          pin: document.documentElement.dataset.pin ?? null,
          tier: document.documentElement.dataset.tier ?? null,
          sources,
        });
      }
    }).observe({ type: "layout-shift", buffered: true });
  });
}

/** The shifts recorded so far (see {@link recordLayoutShifts}). */
export async function layoutShifts(page: Page): Promise<ShiftRecord[]> {
  return page.evaluate(() => window.layoutShifts ?? []);
}

/** Cumulative score of the shifts not caused by recent input. */
export const shiftScore = (shifts: readonly ShiftRecord[]): number =>
  shifts.filter((shift) => !shift.hadRecentInput).reduce((sum, shift) => sum + shift.value, 0);
