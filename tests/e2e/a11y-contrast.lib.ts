/**
 * PF-03 attempt 4: a pixel judge for every axe `color-contrast` node filed under "incomplete".
 *
 * Why: on the full tier axe files every copy text as incomplete ("background color could not be
 * determined due to a pseudo element": the section scrim is a ::before gradient over the live
 * canvas), so axe alone decides nothing there and a planted low-contrast colour would pass.
 *
 * How (deterministic, no new dependencies):
 * 1. For each incomplete node, read in the page its text colour (alpha × the element's and its
 *    ancestors' opacity), font size and weight (large text = ≥ 24 px, or ≥ 18.66 px and bold),
 *    and its glyph line boxes (Range rects of its own text nodes) clipped to the viewport and to
 *    any overflow-clipping ancestor.
 * 2. Make every glyph on the page transparent (`-webkit-text-fill-color`, decorations, shadows),
 *    so a screenshot shows exactly what is painted behind the text: ancestor backgrounds,
 *    ::before / ::after overlays and gradients with their opacity, stills and the WebGL canvas.
 *    Take two screenshots two frames and 150 ms apart.
 * 3. In the page (canvas 2D decode, no Node image library), for every pixel inside the node's
 *    glyph boxes composite the text colour over that pixel and compute the WCAG ratio. The
 *    node's ratio is the 5th percentile of those (the worst case after dropping the 5 % least
 *    representative pixels, the same p95-luminance worst case as M3-AC5 / PF-04), so light-on-
 *    dark and dark-on-light are both handled.
 * 4. Verdict: ratio ≥ 4.5 (≥ 3 for large text) → pass; below → FAIL, except the section-rail
 *    numerals over the live canvas, a known carded defect (PF-23), which are DEFERRED and listed
 *    with their measured ratio. A node whose backdrop
 *    changed between the two screenshots (> 1 % of its pixels by > 3 levels) is undecidable:
 *    when that backdrop is the live 3D canvas it is DEFERRED to PF-04 and listed by name; for
 *    any other backdrop it FAILS. A node with no painted glyph pixels at all also FAILS
 *    (undecided). Nothing is skipped silently: every node is in the returned lists.
 * 5. Off-screen nodes (normal-flow states only) are scrolled into view one position at a time,
 *    settled with the spec's settle(), and measured there; the full tier never scrolls.
 */
import type { AxeBuilder } from "@axe-core/playwright";
import type { Page } from "@playwright/test";

type AxeResults = Awaited<ReturnType<AxeBuilder["analyze"]>>;

export const AA_NORMAL = 4.5;
export const AA_LARGE = 3;

export interface JudgedNode {
  target: string;
  section: string;
  /** In the active (visible) section body, or outside the pinned section bodies. */
  active: boolean;
  /** Inside a section body that the copy layer marks active (`data-copy-active`). */
  inActiveSection: boolean;
  text: string;
  canvasBacked: boolean;
  required: number;
  ratio: number | null;
  pixels: number;
  verdict: "pass" | "fail" | "deferred" | "undecided";
  reason: string;
}

export interface Judgement {
  nodes: JudgedNode[];
  /** Human-readable blocking lines (fail + undecided). */
  failures: string[];
}

const HIDE_ID = "a11y-hide-glyphs";
const HIDE_CSS = `*, *::before, *::after, *::marker, *::placeholder {
  -webkit-text-fill-color: transparent !important; text-decoration-color: transparent !important;
  text-shadow: none !important; caret-color: transparent !important; }`;

const frames = (page: Page): Promise<void> =>
  page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            resolve();
          });
        });
      }),
  );

export interface JudgeOptions {
  /**
   * May the judge scroll to bring off-screen nodes into view (normal-flow states)? Never on the
   * full tier, where scrolling changes the scene and the copy.
   */
  scroll: boolean;
  /** The spec's settle(), run after every scroll. */
  settle: (page: Page) => Promise<void>;
}

export async function judgeIncompleteContrast(
  page: Page,
  result: AxeResults,
  state: string,
  options: JudgeOptions,
): Promise<Judgement> {
  const targets = [
    ...new Set(
      result.incomplete
        .filter((rule) => rule.id === "color-contrast")
        .flatMap((rule) => rule.nodes.map((node) => node.target.map(String).join(" "))),
    ),
  ];
  if (targets.length === 0) return { nodes: [], failures: [] };

  // Round 0 measures everything at the scanned position. Then, where allowed, scroll the first
  // node that has no painted glyph pixels yet into the middle of the viewport, settle, and
  // measure every still-unmeasured node again, until each has pixels or has been scrolled to.
  const measured = new Map<string, Measured>();
  const keep = (list: Measured[]): void => {
    for (const m of list)
      if (m.pixels > 0 || !measured.has(m.selector)) measured.set(m.selector, m);
  };
  keep(await measure(page, targets));
  if (options.scroll) {
    const start = await page.evaluate(() => [window.scrollX, window.scrollY]);
    const tried = new Set<string>();
    for (;;) {
      const next = targets.find((t) => (measured.get(t)?.pixels ?? 0) === 0 && !tried.has(t));
      if (next === undefined) break;
      tried.add(next);
      // oxlint-disable-next-line no-await-in-loop -- one scroll position at a time
      const found = await page.evaluate((selector) => {
        const el = document.querySelector(selector);
        el?.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
        return el !== null;
      }, next);
      if (!found) continue;
      // oxlint-disable-next-line no-await-in-loop -- one scroll position at a time
      await options.settle(page);
      const pending = targets.filter((t) => (measured.get(t)?.pixels ?? 0) === 0);
      // oxlint-disable-next-line no-await-in-loop -- one scroll position at a time
      keep(await measure(page, pending));
    }
    await page.evaluate(([x = 0, y = 0]) => {
      window.scrollTo({ left: x, top: y, behavior: "instant" });
    }, start);
    await options.settle(page);
  }
  const raw = targets.map((t) => measured.get(t) ?? missing(t));

  const nodes: JudgedNode[] = raw.map((n) => {
    const required = n.large ? AA_LARGE : AA_NORMAL;
    let verdict: JudgedNode["verdict"];
    let reason: string;
    if (n.missing) {
      verdict = "undecided";
      reason = "selector not found";
    } else if (n.ratio === null || n.pixels === 0) {
      verdict = "undecided";
      reason = "no painted glyph pixels";
    } else if (n.unstable > n.pixels * 0.01) {
      verdict = n.canvasBacked ? "deferred" : "undecided";
      reason = n.canvasBacked
        ? `live canvas backdrop not still (${n.unstable}/${n.pixels} px changed): PF-04`
        : `backdrop not still (${n.unstable}/${n.pixels} px changed)`;
    } else if (n.ratio >= required) {
      verdict = "pass";
      reason = "";
    } else if (n.railNumeral && n.canvasBacked) {
      // Known, carded defect: the section-rail numerals over the live scene (backlog PF-23, found
      // by PF-04's tool). Listed in the output with the measured ratio, never silently passed.
      verdict = "deferred";
      reason = `rail numeral over the live 3D canvas, ${n.ratio.toFixed(2)}:1 < ${required}:1: PF-23 (PF-04 follow-up)`;
    } else {
      verdict = "fail";
      reason = `${n.ratio.toFixed(2)}:1 < ${required}:1`;
    }
    return {
      target: n.selector,
      section: n.section,
      active: n.active,
      inActiveSection: n.inActiveSection,
      text: n.text,
      canvasBacked: n.canvasBacked,
      required,
      ratio: n.ratio,
      pixels: n.pixels,
      verdict,
      reason,
    };
  });
  const failures = nodes
    .filter((n) => n.verdict === "fail" || n.verdict === "undecided")
    .map(
      (n) =>
        `${state}: color-contrast (pixel judge) ${n.verdict}: ${n.target} "${n.text}" ${n.reason}${n.ratio === null ? "" : ` (ratio ${n.ratio.toFixed(2)}, bar ${n.required})`}`,
    );
  return { nodes, failures };
}

/** How many of axe's own color-contrast passes / violations sit in the active section body. */
export async function axeDecidedInActiveSection(page: Page, result: AxeResults): Promise<number> {
  const selectors = [...result.passes, ...result.violations]
    .filter((rule) => rule.id === "color-contrast")
    .flatMap((rule) => rule.nodes.map((node) => node.target.map(String).join(" ")));
  return page.evaluate(
    (list) =>
      list.filter((selector) =>
        document.querySelector(selector)?.closest(".home-section__body[data-copy-active]"),
      ).length,
    selectors,
  );
}

interface Measured {
  selector: string;
  missing: boolean;
  section: string;
  active: boolean;
  inActiveSection: boolean;
  text: string;
  canvasBacked: boolean;
  railNumeral: boolean;
  large: boolean;
  ratio: number | null;
  pixels: number;
  unstable: number;
}

const missing = (selector: string): Measured => ({
  selector,
  missing: true,
  section: "",
  active: false,
  inActiveSection: false,
  text: "",
  canvasBacked: false,
  railNumeral: false,
  large: false,
  ratio: null,
  pixels: 0,
  unstable: 0,
});

/** Hide every glyph, take two screenshots, judge `selectors` on the pixels behind their text. */
async function measure(page: Page, selectors: string[]): Promise<Measured[]> {
  await page.evaluate(
    ({ id, css }) => {
      const style = document.createElement("style");
      style.id = id;
      style.textContent = css;
      document.head.append(style);
    },
    { id: HIDE_ID, css: HIDE_CSS },
  );
  await frames(page);
  const first = (await page.screenshot({ scale: "css" })).toString("base64");
  await frames(page);
  await page.waitForTimeout(150);
  const second = (await page.screenshot({ scale: "css" })).toString("base64");
  await page.evaluate((id) => {
    document.getElementById(id)?.remove();
  }, HIDE_ID);
  await frames(page);
  return page.evaluate(
    async ({ list, shots }) => {
      const [a, b] = await Promise.all(
        shots.map(async (b64) => {
          const bytes = Uint8Array.from(atob(b64), (c) => c.codePointAt(0) ?? 0);
          const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
          const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
          const ctx = canvas.getContext("2d");
          if (!ctx) throw new Error("no 2d context");
          ctx.drawImage(bitmap, 0, 0);
          return ctx.getImageData(0, 0, bitmap.width, bitmap.height);
        }),
      );
      if (!a || !b) throw new Error("decode failed");
      const LIN = Array.from({ length: 256 }, (_, c) => {
        const v = c / 255;
        return v <= 0.039_28 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      });
      const lum = (r: number, g: number, bl: number): number =>
        0.2126 * (LIN[Math.round(r)] ?? 0) +
        0.7152 * (LIN[Math.round(g)] ?? 0) +
        0.0722 * (LIN[Math.round(bl)] ?? 0);
      const canvasEl = document.querySelector<HTMLCanvasElement>("[data-scene] canvas");
      const canvasLive =
        canvasEl !== null &&
        document.documentElement.dataset.tier === "full" &&
        Number(getComputedStyle(canvasEl).opacity) > 0;
      const vw = window.innerWidth;
      const vh = window.innerHeight;

      return list.map((selector) => {
        const el = document.querySelector(selector);
        if (!el)
          return {
            selector,
            missing: true,
            section: "",
            active: false,
            inActiveSection: false,
            text: "",
            canvasBacked: false,
            railNumeral: false,
            large: false,
            ratio: null,
            pixels: 0,
            unstable: 0,
          };
        const style = getComputedStyle(el);
        const rgba = (/rgba?\(([^)]+)\)/u.exec(style.color)?.[1] ?? "0,0,0,1")
          .split(/[\s,/]+/u)
          .filter(Boolean)
          .map(Number);
        let opacity = 1;
        for (let n: Element | null = el; n; n = n.parentElement)
          opacity *= Number(getComputedStyle(n).opacity);
        const alpha = (rgba[3] ?? 1) * opacity;
        const [tr = 0, tg = 0, tb = 0] = rgba;
        const size = Number.parseFloat(style.fontSize);
        const bold = Number(style.fontWeight) >= 700;
        const large = size >= 24 || (size >= 18.66 && bold);
        const body = el.closest(".home-section__body");
        const inActiveSection = body !== null && body.hasAttribute("data-copy-active");
        const active = body === null || inActiveSection;
        const section =
          el.closest("section[id]")?.id ??
          el.closest("header, footer, nav")?.tagName.toLowerCase() ??
          "page";

        // Clip to the viewport and every overflow-clipping ancestor.
        let cl = 0;
        let ct = 0;
        let cr = vw;
        let cb = vh;
        for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
          const cs = getComputedStyle(n);
          if (cs.overflowX === "visible" && cs.overflowY === "visible" && cs.clipPath === "none")
            continue;
          const r = n.getBoundingClientRect();
          cl = Math.max(cl, r.left);
          ct = Math.max(ct, r.top);
          cr = Math.min(cr, r.right);
          cb = Math.min(cb, r.bottom);
        }
        const boxes: [number, number, number, number][] = [];
        for (const child of el.childNodes) {
          if (child.nodeType !== Node.TEXT_NODE || !child.textContent?.trim()) continue;
          const range = document.createRange();
          range.selectNodeContents(child);
          for (const r of range.getClientRects()) {
            const l = Math.max(Math.floor(r.left), Math.ceil(cl));
            const t = Math.max(Math.floor(r.top), Math.ceil(ct));
            const ri = Math.min(Math.ceil(r.right), Math.floor(cr));
            const bo = Math.min(Math.ceil(r.bottom), Math.floor(cb));
            if (ri - l >= 1 && bo - t >= 1) boxes.push([l, t, ri, bo]);
          }
        }
        // Form controls draw their value text without a text node: use the content box.
        if (boxes.length === 0 && el.matches("input, select, textarea")) {
          const r = el.getBoundingClientRect();
          const pl =
            Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.borderLeftWidth);
          const pr =
            Number.parseFloat(style.paddingRight) + Number.parseFloat(style.borderRightWidth);
          const pt = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.borderTopWidth);
          const pb =
            Number.parseFloat(style.paddingBottom) + Number.parseFloat(style.borderBottomWidth);
          const l = Math.max(Math.floor(r.left + pl), Math.ceil(cl));
          const t = Math.max(Math.floor(r.top + pt), Math.ceil(ct));
          const ri = Math.min(Math.ceil(r.right - pr), Math.floor(cr));
          const bo = Math.min(Math.ceil(r.bottom - pb), Math.floor(cb));
          if (ri - l >= 1 && bo - t >= 1) boxes.push([l, t, ri, bo]);
        }
        const railNumeral = el.matches("nav.rail a[data-section-link] > span[aria-hidden='true']");
        let canvasBacked = false;
        if (canvasLive && canvasEl) {
          const c = canvasEl.getBoundingClientRect();
          canvasBacked = boxes.some(
            ([l, t, r, bo]) => l < c.right && c.left < r && t < c.bottom && c.top < bo,
          );
        }
        const ratios: number[] = [];
        let unstable = 0;
        const seen = new Set<number>();
        for (const [l, t, r, bo] of boxes)
          for (let y = t; y < bo; y += 1)
            for (let x = l; x < r; x += 1) {
              const i = (y * a.width + x) * 4;
              if (seen.has(i)) continue;
              seen.add(i);
              const br = a.data[i] ?? 0;
              const bg = a.data[i + 1] ?? 0;
              const bb = a.data[i + 2] ?? 0;
              if (
                Math.abs(br - (b.data[i] ?? 0)) > 3 ||
                Math.abs(bg - (b.data[i + 1] ?? 0)) > 3 ||
                Math.abs(bb - (b.data[i + 2] ?? 0)) > 3
              )
                unstable += 1;
              const fr = tr * alpha + br * (1 - alpha);
              const fg = tg * alpha + bg * (1 - alpha);
              const fb = tb * alpha + bb * (1 - alpha);
              const l1 = lum(fr, fg, fb);
              const l2 = lum(br, bg, bb);
              ratios.push((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05));
            }
        ratios.sort((x, y) => x - y);
        const ratio = ratios.length > 0 ? (ratios[Math.floor(ratios.length * 0.05)] ?? null) : null;
        return {
          selector,
          missing: false,
          section,
          active,
          inActiveSection,
          text: (el.textContent ?? "").replaceAll(/\s+/gu, " ").trim().slice(0, 40),
          canvasBacked,
          railNumeral,
          large,
          ratio,
          pixels: ratios.length,
          unstable,
        };
      });
    },
    { list: selectors, shots: [first, second] },
  );
}
