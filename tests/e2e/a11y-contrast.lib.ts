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
  /** Canvas in the hit stack under the glyphs and visibly showing through, still without it. */
  canvasBacked: boolean;
  railNumeral: boolean;
  required: number;
  ratio: number | null;
  ratioMin: number | null;
  ratioP1: number | null;
  pixels: number;
  unstable: number;
  unstableHidden: number;
  canvasVisible: number;
  /** [hits, samples] of elementsFromPoint containing the canvas. */
  stack: [number, number];
  verdict: "pass" | "fail" | "deferred" | "finding" | "undecided";
  /** The filed-finding selector this node matched, if any. */
  finding: string | null;
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

/** Gap between the two shots of a pair: any backdrop change in it is motion. */
const STILL_GAP_MS = 150;
/** A backdrop pixel "changed" when a channel moved by more than this many levels. */
const PIXEL_TOLERANCE = 3;
/** More than this share of a node's pixels changing = the backdrop is not still. */
const UNSTABLE_SHARE = 0.01;
/** Deferral to the canvas needs the canvas in the hit stack at ≥ this share of sampled glyph pixels. */
const CANVAS_STACK_SHARE = 0.95;
/** …and visibly showing through (pixel changes when hidden) at ≥ this share of glyph pixels. */
const CANVAS_VISIBLE_SHARE = 0.5;
/** …and ≥ this share of the moving pixels must be pixels where the canvas shows through. */
const MOTION_ON_CANVAS_SHARE = 0.99;
/** The node's ratio is this percentile of its per-pixel ratios (see the PR body, attempt 5). */
export const RATIO_PERCENTILE = 0.05;

const HIDE_CANVAS_ID = "a11y-hide-canvas";
const HIDE_CANVAS_CSS = "[data-scene] canvas { visibility: hidden !important; }";

const share = (k: number, of: number): number => (of > 0 ? k / of : 0);

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
  /** Findings filed in the PR (PF-03 AC3, carded): a FAILING match is a "finding". */
  findings: readonly {
    readonly selector: string;
    readonly card: string;
    /** Exempt only in these exact states, and only while the ratio stays ≥ the floor. */
    readonly floors: Readonly<Record<string, number>>;
  }[];
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
  const filedSelectors = options.findings.map((f) => f.selector);
  keep(await measure(page, targets, filedSelectors));
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
      keep(await measure(page, pending, filedSelectors));
    }
    await page.evaluate(([x = 0, y = 0]) => {
      window.scrollTo({ left: x, top: y, behavior: "instant" });
    }, start);
    await options.settle(page);
  }
  const raw = targets.map((t) => measured.get(t) ?? missing(t));

  const nodes: JudgedNode[] = raw.map((n) => {
    const required = n.large ? AA_LARGE : AA_NORMAL;
    // Canvas-backed (attempt 5) = the canvas is in the hit stack under the glyphs AND visibly
    // shows through behind them (those pixels change when the canvas is hidden), with the
    // canvas-hidden backdrop still. Geometry alone (the canvas covers the viewport) is not enough.
    const stillWithoutCanvas = n.unstableHidden <= n.pixels * UNSTABLE_SHARE;
    const canvasBacked =
      n.pixels > 0 &&
      share(n.stackHits, n.stackSamples) >= CANVAS_STACK_SHARE &&
      share(n.canvasVisible, n.pixels) >= CANVAS_VISIBLE_SHARE &&
      stillWithoutCanvas;
    const moving = n.unstable > n.pixels * UNSTABLE_SHARE;
    const motionIsCanvas =
      canvasBacked && share(n.unstableOnCanvas, n.unstable) >= MOTION_ON_CANVAS_SHARE;
    const filed = options.findings.find((f) => f.selector === n.finding);
    const floor = filed?.floors[state];
    let verdict: JudgedNode["verdict"];
    let reason: string;
    if (n.missing) {
      verdict = "undecided";
      reason = "selector not found";
    } else if (n.ratio === null || n.pixels === 0) {
      verdict = "undecided";
      reason = "no painted glyph pixels";
    } else if (moving && motionIsCanvas) {
      verdict = "deferred";
      reason = `live canvas backdrop not still (${n.unstable}/${n.pixels} px changed, still with the canvas hidden; canvas under ${n.stackHits}/${n.stackSamples} sampled glyph px): PF-04`;
    } else if (moving) {
      verdict = "undecided";
      reason = stillWithoutCanvas
        ? `backdrop not still (${n.unstable}/${n.pixels} px changed) and not shown to be the canvas (canvas visible at ${n.canvasVisible}/${n.pixels} px, in the hit stack at ${n.stackHits}/${n.stackSamples}, moving px on canvas ${n.unstableOnCanvas}/${n.unstable})`
        : `backdrop not still and still moving with the canvas hidden (${n.unstableHidden}/${n.pixels} px changed): not the canvas`;
    } else if (n.ratio >= required) {
      verdict = "pass";
      reason = "";
    } else if (filed !== undefined && floor !== undefined && !canvasBacked && n.ratio >= floor) {
      verdict = "finding";
      reason = `${n.ratio.toFixed(2)}:1 < ${required}:1, filed finding (${filed.card}, PF-03 AC3; floor ${floor.toFixed(2)} in this state)`;
    } else if (filed !== undefined && floor !== undefined && !canvasBacked) {
      verdict = "fail";
      reason = `${n.ratio.toFixed(2)}:1 < ${required}:1 and below its ${filed.card} floor ${floor.toFixed(2)}:1 (got worse than filed)`;
    } else if (n.railNumeral && canvasBacked) {
      // Known, carded defect: the section-rail numerals over the live scene (backlog PF-23, found
      // by PF-04's tool). Listed in the output with the measured ratio, never silently passed.
      verdict = "deferred";
      reason = `rail numeral over the live 3D canvas (canvas visible at ${n.canvasVisible}/${n.pixels} px), ${n.ratio.toFixed(2)}:1 < ${required}:1: PF-23 (PF-04 follow-up)`;
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
      canvasBacked,
      railNumeral: n.railNumeral,
      required,
      ratio: n.ratio,
      ratioMin: n.ratioMin,
      ratioP1: n.ratioP1,
      pixels: n.pixels,
      unstable: n.unstable,
      unstableHidden: n.unstableHidden,
      canvasVisible: n.canvasVisible,
      stack: [n.stackHits, n.stackSamples],
      verdict,
      reason,
      finding: n.finding,
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
  railNumeral: boolean;
  finding: string | null;
  large: boolean;
  ratio: number | null;
  ratioMin: number | null;
  ratioP1: number | null;
  pixels: number;
  /** Pixels that changed between the two shots (canvas visible). */
  unstable: number;
  /** Pixels that changed between the two shots taken with the canvas hidden. */
  unstableHidden: number;
  /** Pixels that change when the canvas is hidden: the canvas shows through there. */
  canvasVisible: number;
  /** Moving pixels (canvas visible) that are also canvas-showing pixels. */
  unstableOnCanvas: number;
  /** Sampled glyph pixels whose elementsFromPoint stack contains the canvas, of samples. */
  stackHits: number;
  stackSamples: number;
}

const missing = (selector: string): Measured => ({
  selector,
  missing: true,
  section: "",
  active: false,
  inActiveSection: false,
  text: "",
  railNumeral: false,
  finding: null,
  large: false,
  ratio: null,
  ratioMin: null,
  ratioP1: null,
  pixels: 0,
  unstable: 0,
  unstableHidden: 0,
  canvasVisible: 0,
  unstableOnCanvas: 0,
  stackHits: 0,
  stackSamples: 0,
});

/** Hide every glyph, take two screenshots, judge `selectors` on the pixels behind their text. */
async function measure(
  page: Page,
  selectors: string[],
  findings: readonly string[],
): Promise<Measured[]> {
  await page.evaluate(
    ({ id, css }) => {
      const style = document.createElement("style");
      style.id = id;
      style.textContent = css;
      document.head.append(style);
    },
    { id: HIDE_ID, css: HIDE_CSS },
  );
  const shoot = async (): Promise<[string, string]> => {
    await frames(page);
    const a = (await page.screenshot({ scale: "css" })).toString("base64");
    await frames(page);
    await page.waitForTimeout(STILL_GAP_MS);
    const b = (await page.screenshot({ scale: "css" })).toString("base64");
    return [a, b];
  };
  const [first, second] = await shoot();
  // Attempt 5 (QA Medium): the same pair again with the WebGL canvas hidden. Motion that is
  // still there without the canvas is not the canvas; pixels that change when the canvas is
  // hidden are pixels where the canvas actually shows through behind the glyphs.
  const hasCanvas = await page.evaluate(
    ({ id, css }) => {
      if (document.documentElement.dataset.tier !== "full") return false;
      if (!document.querySelector("[data-scene] canvas")) return false;
      const style = document.createElement("style");
      style.id = id;
      style.textContent = css;
      document.head.append(style);
      return true;
    },
    { id: HIDE_CANVAS_ID, css: HIDE_CANVAS_CSS },
  );
  const [third, fourth] = hasCanvas ? await shoot() : [first, second];
  await page.evaluate(
    (ids) => {
      for (const id of ids) document.getElementById(id)?.remove();
    },
    [HIDE_ID, HIDE_CANVAS_ID],
  );
  await frames(page);
  return page.evaluate(
    async ({ list, shots, filed, percentile, tol }) => {
      const [a, b, hidA, hidB] = await Promise.all(
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
      if (!a || !b || !hidA || !hidB) throw new Error("decode failed");
      const differs = (p: ImageData, q: ImageData, i: number): boolean =>
        Math.abs((p.data[i] ?? 0) - (q.data[i] ?? 0)) > tol ||
        Math.abs((p.data[i + 1] ?? 0) - (q.data[i + 1] ?? 0)) > tol ||
        Math.abs((p.data[i + 2] ?? 0) - (q.data[i + 2] ?? 0)) > tol;
      // Browser-normalised colour (oklch, lab, color(), color-mix, hsl, named, …) → sRGB 0–255 + alpha.
      const probe = new OffscreenCanvas(1, 1).getContext("2d", { willReadFrequently: true });
      if (!probe) throw new Error("no 2d context");
      const toRgba = (css: string): [number, number, number, number] => {
        probe.clearRect(0, 0, 1, 1);
        probe.fillStyle = "#000";
        probe.fillStyle = css;
        probe.fillRect(0, 0, 1, 1);
        const px = probe.getImageData(0, 0, 1, 1).data;
        const al = px[3] ?? 0;
        // getImageData un-premultiplies; at alpha 0 the channels are meaningless.
        return al === 0 ? [0, 0, 0, 0] : [px[0] ?? 0, px[1] ?? 0, px[2] ?? 0, al / 255];
      };
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
            railNumeral: false,
            finding: null,
            large: false,
            ratio: null,
            ratioMin: null,
            ratioP1: null,
            pixels: 0,
            unstable: 0,
            unstableHidden: 0,
            canvasVisible: 0,
            unstableOnCanvas: 0,
            stackHits: 0,
            stackSamples: 0,
          };
        const style = getComputedStyle(el);
        const rgba = toRgba(style.color);
        let opacity = 1;
        for (let n: Element | null = el; n; n = n.parentElement)
          opacity *= Number(getComputedStyle(n).opacity);
        const alpha = rgba[3] * opacity;
        const [tr, tg, tb] = rgba;
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
        const finding = filed.find((f) => el.matches(f)) ?? null;
        const railNumeral = el.matches("nav.rail a[data-section-link] > span[aria-hidden='true']");
        // Cross-check (attempt 5): is the canvas in the hit stack under the sampled glyph pixels?
        // The scene is pointer-events:none, so hit-testing is enabled for the check only.
        let stackHits = 0;
        let stackSamples = 0;
        if (canvasLive && canvasEl) {
          const hit = document.createElement("style");
          hit.textContent =
            "[data-scene], [data-scene] canvas { pointer-events: auto !important; }";
          document.head.append(hit);
          for (const [l, t, r, bo] of boxes)
            for (let y = t + 1; y < bo; y += 4)
              for (let x = l + 1; x < r; x += 4) {
                stackSamples += 1;
                if (document.elementsFromPoint(x + 0.5, y + 0.5).includes(canvasEl)) stackHits += 1;
              }
          hit.remove();
        }
        const ratios: number[] = [];
        let unstable = 0;
        let unstableHidden = 0;
        let canvasVisible = 0;
        let unstableOnCanvas = 0;
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
              const onCanvas = differs(a, hidA, i) || differs(b, hidB, i);
              if (onCanvas) canvasVisible += 1;
              if (differs(a, b, i)) {
                unstable += 1;
                if (onCanvas) unstableOnCanvas += 1;
              }
              if (differs(hidA, hidB, i)) unstableHidden += 1;
              const fr = tr * alpha + br * (1 - alpha);
              const fg = tg * alpha + bg * (1 - alpha);
              const fb = tb * alpha + bb * (1 - alpha);
              const l1 = lum(fr, fg, fb);
              const l2 = lum(br, bg, bb);
              ratios.push((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05));
            }
        ratios.sort((x, y) => x - y);
        const ratio =
          ratios.length > 0 ? (ratios[Math.floor(ratios.length * percentile)] ?? null) : null;
        const ratioMin = ratios[0] ?? null;
        const ratioP1 =
          ratios.length > 0 ? (ratios[Math.floor(ratios.length * 0.01)] ?? null) : null;
        return {
          selector,
          missing: false,
          section,
          active,
          inActiveSection,
          text: (el.textContent ?? "").replaceAll(/\s+/gu, " ").trim().slice(0, 40),
          railNumeral,
          finding,
          large,
          ratio,
          ratioMin,
          ratioP1,
          pixels: ratios.length,
          unstable,
          unstableHidden,
          canvasVisible,
          unstableOnCanvas,
          stackHits,
          stackSamples,
        };
      });
    },
    {
      list: selectors,
      shots: [first, second, third, fourth],
      filed: findings,
      percentile: RATIO_PERCENTILE,
      tol: PIXEL_TOLERANCE,
    },
  );
}
