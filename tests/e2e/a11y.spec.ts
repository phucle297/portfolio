/**
 * PF-03 (M3-AC4): automated accessibility scan with axe-core. Fails on any serious or critical
 * violation in each state a visitor can reach:
 * - full tier at 1440×900 at each of the 6 key scroll positions (hardware GPU spoofed; the scene
 *   renders on SwiftShader);
 * - static tier at 390×844;
 * - reduced motion (1440×900);
 * - no JS (1440×900 and 390×844; page scripts blocked by CSP so axe itself can still run);
 * - the contact form showing all three errors.
 * Every violation (any impact) is written to test-results/a11y/ (override with A11Y_OUT) so minor
 * and moderate ones are visible too.
 *
 * Determinism (QA-PF03-1): every scan first waits until the page has settled — no finite Web
 * Animation or CSS transition is running or pending, and every scroll-revealed block in view is
 * revealed at full effective opacity — for three frames in a row. No fixed sleeps.
 * Error-state contrast (QA-PF03-2): at 1440 axe can only file the error texts under "incomplete"
 * (a still image sits behind the translucent card), so the error state is also scanned at 390×844,
 * where axe must judge them (they must be color-contrast *passes*), and a computed-contrast
 * fallback checks them at both widths. The open mobile menu state is added by PF-11.
 * Runner setup stays in this spec; playwright.config.ts is untouched.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import {
  axeDecidedInActiveSection,
  judgeIncompleteContrast,
  type JudgedNode,
  type Judgement,
} from "./a11y-contrast.lib";
import {
  expect,
  test,
  type Browser,
  type BrowserContextOptions,
  type Page,
} from "@playwright/test";

const OUT = process.env.A11Y_OUT ?? join(process.cwd(), "test-results", "a11y");
/** Key scroll progress per section (`KEY_PROGRESS` in @shared/lib/timeline, kf-01…kf-06). */
const KEY_PROGRESS = [0.03, 0.21, 0.41, 0.6, 0.76, 0.96] as const;
const BLOCKING = new Set(["serious", "critical"]);

interface Finding {
  state: string;
  id: string;
  impact: string;
  help: string;
  targets: string[];
}

type AxeResults = Awaited<ReturnType<AxeBuilder["analyze"]>>;
type Rgba = [number, number, number, number];
type Rgb = [number, number, number];

const STATES_DIR = join(OUT, "states");
/** The three contact-form error texts (QA-PF03-2). */
const ERROR_IDS = ["contact-name-error", "contact-email-error", "contact-brief-error"] as const;
/** WCAG 2.x AA minimum for normal-size text. */
const AA_NORMAL = 4.5;

/**
 * Wait until nothing on the page is still moving, then scan (QA-PF03-1, attempt 3).
 *
 * All of these must hold for 3 consecutive frames:
 * 1. No finite animation or transition is running or pending (Motion's `animate` is WAAPI, CSS
 *    transitions show up as CSSTransition).
 * 2. Every `[data-reveal]` block that is in view by the reveal's own measure (≥ 15 % of its
 *    AREA inside the viewport and its clipping ancestors, as Motion's `inView({ amount: .15 })`
 *    / IntersectionObserver count it) has finished ITS OWN reveal: it carries `data-revealed`
 *    and its own computed opacity is 1. Ancestor opacity is deliberately not multiplied in: on
 *    the full tier (M2) every section body stays pinned in the viewport and the copy layer
 *    scrubs inactive bodies to opacity 0, so a revealed card can sit under a 0-opacity body
 *    forever (attempt 2 timed out on exactly that at p .03).
 * 3. The scroll-linked copy is still: the copy layer writes inline custom properties
 *    (`--copy-o`, `--copy-y`, `--beat-o`, `--footer-o`, the progress bar's transform) from the
 *    stage's catch-up loop, which is not an animation, so rule 1 cannot see it. Every inline
 *    `style` on the page, the scroll position and the computed opacity of each section body
 *    must be identical to the previous frame. A crossfade between sections or beats therefore
 *    always finishes before axe runs, wherever it comes from.
 */
async function settle(page: Page): Promise<void> {
  await page.evaluate(() => {
    Reflect.set(window, "a11ySettledFrames", 0);
    Reflect.set(window, "a11ySettleSig", "");
  });
  const settled = page.waitForFunction(
    () => {
      const movingList = document.getAnimations().filter((animation) => {
        const iterations = animation.effect?.getComputedTiming().iterations ?? 1;
        if (iterations === Number.POSITIVE_INFINITY) return false;
        return animation.pending || animation.playState === "running";
      });
      const unrevealedList = Array.from(document.querySelectorAll("[data-reveal]")).filter((el) => {
        const style = getComputedStyle(el);
        if (style.display === "none") return false;
        // Area share inside the viewport and every overflow-clipping ancestor.
        const rect = el.getBoundingClientRect();
        let left = Math.max(rect.left, 0);
        let top = Math.max(rect.top, 0);
        let right = Math.min(rect.right, window.innerWidth);
        let bottom = Math.min(rect.bottom, window.innerHeight);
        for (
          let node = el.parentElement;
          node && node !== document.body;
          node = node.parentElement
        ) {
          const cs = getComputedStyle(node);
          if (cs.overflowX === "visible" && cs.overflowY === "visible") continue;
          const clip = node.getBoundingClientRect();
          left = Math.max(left, clip.left);
          top = Math.max(top, clip.top);
          right = Math.min(right, clip.right);
          bottom = Math.min(bottom, clip.bottom);
        }
        const area = Math.max(0, right - left) * Math.max(0, bottom - top);
        if (area / Math.max(1, rect.width * rect.height) < 0.15) return false;
        return !el.hasAttribute("data-revealed") || Number(style.opacity) < 1;
      });
      const sig = JSON.stringify([
        window.scrollX,
        window.scrollY,
        Array.from(document.querySelectorAll("[style]"), (el) => el.getAttribute("style")),
        Array.from(
          document.querySelectorAll(".home-section__body"),
          (el) => getComputedStyle(el).opacity,
        ),
      ]);
      const scrubbing = sig !== Reflect.get(window, "a11ySettleSig");
      Reflect.set(window, "a11ySettleSig", sig);
      Reflect.set(
        window,
        "a11ySettleWhy",
        JSON.stringify({
          moving: movingList.map((a) => {
            const t = a.effect instanceof KeyframeEffect ? a.effect.target : null;
            return `${a.constructor.name} ${a.playState}${a.pending ? " pending" : ""} on ${t?.tagName ?? "?"}.${t?.className ?? ""} t=${String(a.currentTime)}`;
          }),
          unrevealed: unrevealedList.map((el) => {
            const r = el.getBoundingClientRect();
            return `${el.className} revealed=${String(el.hasAttribute("data-revealed"))} rect=${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)}x${Math.round(r.height)} op=${getComputedStyle(el).opacity}`;
          }),
          scrubbing,
          scrollY: window.scrollY,
        }),
      );
      const still = movingList.length === 0 && unrevealedList.length === 0 && !scrubbing;
      const frames = still ? Number(Reflect.get(window, "a11ySettledFrames")) + 1 : 0;
      Reflect.set(window, "a11ySettledFrames", frames);
      return frames >= 3;
    },
    null,
    { polling: "raf", timeout: 20_000 },
  );
  try {
    await settled;
  } catch (error) {
    // Say what was still moving or hidden, so a timeout is diagnosable from the log alone.
    const why = await page
      .evaluate(() => String(Reflect.get(window, "a11ySettleWhy")))
      .catch(() => "unknown");
    throw new Error(`page never settled: ${why}`, { cause: error });
  }
}

async function open(
  browser: Browser,
  options: BrowserContextOptions & { gpu?: boolean; noJs?: boolean } = {},
): Promise<Page> {
  const { gpu = false, noJs = false, ...context } = options;
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...context });
  const page = await ctx.newPage();
  if (noJs) {
    // "No JS" for the page, but not for axe: a context with JavaScript disabled also stops axe's own
    // timers (the scan never finishes). Serving the document with `script-src 'none'` blocks every
    // page script, inline or external, while the injected axe still runs. The site has no
    // <noscript> content, so this renders exactly what a no-JS visitor gets (checked below).
    await page.route("**/*", async (route) => {
      if (route.request().resourceType() !== "document") return route.continue();
      const response = await route.fetch();
      return route.fulfill({
        response,
        headers: { ...response.headers(), "content-security-policy": "script-src 'none'" },
      });
    });
  } else {
    // Hardware GPU spoofed for the full tier; otherwise answer "no hardware WebGL" (static tier).
    await page.route(/probe\.worker/u, (route) =>
      route.fulfill({
        contentType: "text/javascript",
        body: `postMessage(${gpu ? "true" : "false"});`,
      }),
    );
  }
  await page.goto("/");
  await page.waitForLoadState("load");
  return page;
}

/** Persist one state's violations (any impact) and contrast verdicts for the afterAll report. */
function record(state: string, result: AxeResults, judgement: Judgement): void {
  const findings: Finding[] = result.violations.map((v) => ({
    state,
    id: v.id,
    impact: v.impact ?? "unknown",
    help: v.help,
    targets: v.nodes.map((n) => n.target.join(" ")),
  }));
  mkdirSync(STATES_DIR, { recursive: true });
  const slug = state.replaceAll(/[^\w]+/gu, "-").replaceAll(/^-|-$/gu, "");
  writeFileSync(
    join(STATES_DIR, `${slug}.json`),
    JSON.stringify({ state, findings, contrast: judgement.nodes }, null, 1),
  );
}

/** Pixel-judge verdicts per scanned result (see a11y-contrast.lib.ts). */
const JUDGED = new WeakMap<AxeResults, Judgement>();

const count = (nodes: readonly JudgedNode[], verdict: JudgedNode["verdict"]): number =>
  nodes.filter((n) => n.verdict === verdict).length;

/**
 * Settle, scan the whole page, judge every color-contrast "incomplete" node on the real pixels
 * (attempt 4), record everything; returns the raw result.
 */
async function analyze(page: Page, state: string): Promise<AxeResults> {
  await settle(page);
  const result = await new AxeBuilder({ page }).analyze();
  const judgement = await judgeIncompleteContrast(page, result, state);
  JUDGED.set(result, judgement);
  record(state, result, judgement);
  const { nodes } = judgement;
  const deferred = nodes.filter((n) => n.verdict === "deferred");
  process.stdout.write(
    `contrast fallback · ${state}: ${nodes.length} incomplete → ${count(nodes, "pass")} pass, ${count(nodes, "fail")} fail, ${deferred.length} deferred to PF-04, ${count(nodes, "undecided")} undecided${deferred.length > 0 ? ` · deferred: ${deferred.map((n) => `${n.target} (${n.reason})`).join("; ")}` : ""}\n`,
  );
  return result;
}

/** Serious/critical axe violations plus every pixel-judge failure or undecided node. */
const blockingOf = (state: string, result: AxeResults): string[] => [
  ...result.violations
    .filter((v) => BLOCKING.has(v.impact ?? ""))
    .map(
      (v) =>
        `${state}: ${v.impact}: ${v.id} (${v.help}) at ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`,
    ),
  ...(JUDGED.get(result)?.failures ?? []),
];

/** Scan and return the blocking findings. */
async function scan(page: Page, state: string): Promise<string[]> {
  return blockingOf(state, await analyze(page, state));
}

type ContrastVerdict = "pass" | "incomplete" | "violation" | "not checked";

/** Where axe's color-contrast rule put each error text. */
const hasContrastNode = (list: AxeResults["passes"], id: string): boolean =>
  list
    .filter((rule) => rule.id === "color-contrast")
    .some((rule) => rule.nodes.some((node) => node.target.join(" ").includes(`#${id}`)));

function errorVerdicts(result: AxeResults): Record<string, ContrastVerdict> {
  const has = hasContrastNode;
  return Object.fromEntries(
    ERROR_IDS.map((id) => {
      if (has(result.violations, id)) return [id, "violation"];
      if (has(result.incomplete, id)) return [id, "incomplete"];
      if (has(result.passes, id)) return [id, "pass"];
      return [id, "not checked"];
    }),
  );
}

const parseColor = (value: string): Rgba => {
  const parts = (/rgba?\(([^)]+)\)/u.exec(value)?.[1] ?? "0, 0, 0, 0")
    .split(/[\s,/]+/u)
    .filter(Boolean)
    .map(Number);
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, parts[3] ?? 1];
};
const over = (top: Rgba, bottom: Rgb): Rgb => [
  top[0] * top[3] + bottom[0] * (1 - top[3]),
  top[1] * top[3] + bottom[1] * (1 - top[3]),
  top[2] * top[3] + bottom[2] * (1 - top[3]),
];
const channel = (c: number): number => {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const luminance = ([r, g, b]: Rgb): number =>
  0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);

/**
 * Computed-contrast fallback for the error texts: the text colour against its ancestors'
 * background colours composited over the page background (images behind are ignored, which is
 * exactly what axe cannot decide at 1440).
 */
async function computedErrorContrast(page: Page): Promise<Record<string, number>> {
  const styles = await page.evaluate(
    (ids) =>
      ids.map((id) => {
        const el = document.getElementById(id);
        const backgrounds: string[] = [];
        for (let node: Element | null = el; node; node = node.parentElement)
          backgrounds.push(getComputedStyle(node).backgroundColor);
        return { id, color: el ? getComputedStyle(el).color : "", backgrounds };
      }),
    ERROR_IDS,
  );
  const out: Record<string, number> = {};
  for (const { id, color, backgrounds } of styles) {
    // Innermost first: composite from the root (white canvas default) up to the element.
    let bg: Rgb = [255, 255, 255];
    for (const layer of backgrounds.toReversed()) bg = over(parseColor(layer), bg);
    const fg = over(parseColor(color), bg);
    const [hi, lo] = [luminance(fg), luminance(bg)].toSorted((a, b) => b - a);
    out[id] = ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
  }
  return out;
}

async function scrollToProgress(page: Page, p: number): Promise<void> {
  await page.evaluate((progress) => {
    const max = document.documentElement.scrollHeight - window.innerHeight;
    window.scrollTo({ top: max * progress, behavior: "instant" });
  }, p);
  // The copy fades in on scroll: scan() waits for it to settle (no fixed sleep).
}

// Not serial: every state is its own browser context, so one failing state must not skip the
// others (QA-PF03-1). Each state persists its own results file; afterAll builds the report from
// all of them, whichever worker ran them.

test("full tier at 1440×900, at each of the 6 key scroll positions", async ({ browser }) => {
  test.setTimeout(240_000);
  const page = await open(browser, { gpu: true });
  await expect(page.locator("html")).toHaveAttribute("data-tier", "full", { timeout: 90_000 });
  const blocking: string[] = [];
  const activeDecided: string[] = [];
  for (const [i, p] of KEY_PROGRESS.entries()) {
    // oxlint-disable-next-line no-await-in-loop -- one scroll position at a time
    await scrollToProgress(page, p);
    // oxlint-disable-next-line no-await-in-loop -- one scroll position at a time
    await expect(page.locator("html")).toHaveAttribute("data-tier", "full");
    const state = `full tier, key ${i + 1} (p = ${p})`;
    // oxlint-disable-next-line no-await-in-loop -- one scroll position at a time
    const result = await analyze(page, state);
    blocking.push(...blockingOf(state, result));
    // The ACTIVE section's copy must actually be judged at every position (attempt 4): by axe
    // itself or by the pixel judge, never left to "incomplete".
    const judged =
      JUDGED.get(result)?.nodes.filter(
        (n) => n.inActiveSection && (n.verdict === "pass" || n.verdict === "fail"),
      ).length ?? 0;
    // oxlint-disable-next-line no-await-in-loop -- one scroll position at a time
    const byAxe = await axeDecidedInActiveSection(page, result);
    activeDecided.push(`${state}: ${judged} by pixel judge + ${byAxe} by axe`);
    if (judged + byAxe === 0) blocking.push(`${state}: no contrast verdict for the active section`);
  }
  await page.context().close();
  test
    .info()
    .annotations.push({ type: "active section decided", description: activeDecided.join(" · ") });
  expect(blocking, "serious/critical axe violations and contrast failures").toEqual([]);
});

test("static tier at 390×844", async ({ browser }) => {
  const page = await open(browser, {
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  await expect(page.locator("html")).toHaveAttribute("data-tier", "static");
  expect(await scan(page, "static tier 390×844"), "serious/critical axe violations").toEqual([]);
  await page.context().close();
});

test("reduced motion at 1440×900", async ({ browser }) => {
  const page = await open(browser, { reducedMotion: "reduce", gpu: true });
  await expect(page.locator("html")).not.toHaveClass(/motion-ok/u);
  await expect(page.locator("html")).toHaveAttribute("data-tier", "static");
  expect(await scan(page, "reduced motion 1440×900"), "serious/critical axe violations").toEqual(
    [],
  );
  await page.context().close();
});

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`no JS at ${viewport.width}×${viewport.height}`, async ({ browser }) => {
    const page = await open(browser, { noJs: true, viewport });
    // No page script ran: the inline pre-paint script never added its "js" class.
    await expect(page.locator("html")).not.toHaveClass(/\bjs\b/u);
    expect(
      await scan(page, `no JS ${viewport.width}×${viewport.height}`),
      "serious/critical axe violations",
    ).toEqual([]);
    await page.context().close();
  });
}

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`contact form showing all three errors at ${viewport.width}×${viewport.height}`, async ({
    browser,
  }) => {
    const mobile = viewport.width < 768;
    const page = await open(browser, { viewport, isMobile: mobile, hasTouch: mobile });
    const form = page.locator("[data-contact-form]");
    await form.scrollIntoViewIfNeeded();
    await form.locator('button[type="submit"]').click();
    await expect(form.locator(".field__error:visible")).toHaveCount(3);
    await expect(form.locator('[aria-invalid="true"]')).toHaveCount(3);
    for (const id of ERROR_IDS) {
      // oxlint-disable-next-line no-await-in-loop -- bring each error text fully into view
      await page.locator(`#${id}`).scrollIntoViewIfNeeded();
    }
    const state = `contact form, 3 errors, ${viewport.width}×${viewport.height}`;
    const result = await analyze(page, state);
    const verdicts = errorVerdicts(result);
    const ratios = await computedErrorContrast(page);
    await page.context().close();
    expect(blockingOf(state, result), "serious/critical axe violations").toEqual([]);
    // axe must actually judge the error texts where it can (390: no image behind the card)…
    if (mobile)
      expect(verdicts, "axe color-contrast verdict per error text at 390").toEqual(
        Object.fromEntries(ERROR_IDS.map((id) => [id, "pass"])),
      );
    else
      for (const id of ERROR_IDS)
        expect(["pass", "incomplete"], `axe color-contrast verdict for #${id}`).toContain(
          verdicts[id],
        );
    // …and the computed fallback holds at both widths, so "incomplete" can never hide a bad colour.
    for (const id of ERROR_IDS)
      expect(ratios[id] ?? 0, `computed contrast of #${id}`).toBeGreaterThanOrEqual(AA_NORMAL);
  });
}

test.afterAll(() => {
  let files: string[] = [];
  try {
    files = readdirSync(STATES_DIR).filter((f) => f.endsWith(".json"));
  } catch {
    return;
  }
  const states = files.map((f): { state: string; findings: Finding[] } => {
    const parsed: unknown = JSON.parse(readFileSync(join(STATES_DIR, f), "utf8"));
    const state: unknown =
      parsed !== null && typeof parsed === "object" ? Reflect.get(parsed, "state") : "";
    const list: unknown =
      parsed !== null && typeof parsed === "object" ? Reflect.get(parsed, "findings") : [];
    return {
      state: String(state),
      findings: Array.isArray(list) ? list.filter((x): x is Finding => typeof x === "object") : [],
    };
  });
  const findings = states.flatMap((s) => s.findings);
  const contrastRows = files.map((f) => {
    const parsed: unknown = JSON.parse(readFileSync(join(STATES_DIR, f), "utf8"));
    const state: unknown =
      parsed !== null && typeof parsed === "object" ? Reflect.get(parsed, "state") : "";
    const raw: unknown =
      parsed !== null && typeof parsed === "object" ? Reflect.get(parsed, "contrast") : [];
    const nodes = Array.isArray(raw)
      ? raw.filter((x): x is JudgedNode => x !== null && typeof x === "object")
      : [];
    const deferred = nodes.filter((n) => n.verdict === "deferred").map((n) => n.target);
    return `| ${String(state)} | ${nodes.length} | ${count(nodes, "pass")} | ${count(nodes, "fail")} | ${deferred.length}${deferred.length > 0 ? `: ${deferred.join("<br>")}` : ""} | ${count(nodes, "undecided")} |`;
  });
  const rows = findings.map(
    (f) =>
      `| ${f.state} | ${f.impact} | ${f.id} | ${f.help} | ${f.targets.slice(0, 3).join("<br>")}${f.targets.length > 3 ? ` (+${f.targets.length - 3})` : ""} |`,
  );
  const md = [
    `axe-core scan: ${states.length} states, ${findings.length} violations (any impact), ${findings.filter((f) => BLOCKING.has(f.impact)).length} serious/critical.`,
    "",
    `States: ${states.map((s) => s.state).join("; ")}.`,
    "",
    "| State | Impact | Rule | Help | Targets |",
    "|---|---|---|---|---|",
    ...rows,
    "",
    "Contrast pixel judge (axe color-contrast incomplete nodes; SwiftShader on the full tier):",
    "",
    "| State | Incomplete | Pass | Fail | Deferred to PF-04 (live canvas) | Undecided |",
    "|---|---|---|---|---|---|",
    ...contrastRows,
  ].join("\n");
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "a11y.md"), `${md}\n`);
  writeFileSync(join(OUT, "a11y.json"), JSON.stringify(findings, null, 1));
  process.stdout.write(`${md}\n`);
});
