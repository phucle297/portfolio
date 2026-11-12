import { expect, test } from "@playwright/test";
import { PUBLIC_EMAIL } from "../../src/shared/config/contact";
import { SECTION_IDS } from "./helpers";

test.describe("structure and copy", () => {
  test("M1-AC10 semantic structure", async ({ page }) => {
    await page.goto("/");
    expect(
      await page.locator("main > section[id]").evaluateAll((els) => els.map((e) => e.id)),
    ).toEqual(SECTION_IDS);
    await expect(page.locator("h1")).toHaveCount(1);
    expect((await page.locator("h1").innerText()).replace(/\s+/g, " ").trim()).toBe(
      "Phúc Lê, developing.",
    );
    const h2Sections = await page
      .locator("main h2")
      .evaluateAll((els) => els.map((e) => e.closest("section")?.id));
    expect(h2Sections).toEqual(SECTION_IDS.slice(1));
    await expect(page.locator("body > header")).toHaveCount(1);
    await expect(page.locator("header nav[aria-label]")).toHaveCount(1);
    await expect(page.locator('nav[aria-label="Sections"] [aria-current="true"]')).toHaveCount(1);
    await expect(page.locator("main")).toHaveCount(1);
    await expect(page.locator("body > footer")).toHaveCount(1);
    await expect(page.locator(".skip-link, a[href='#main']").first()).toHaveAttribute(
      "href",
      "#main",
    );
    const navHrefs = await page
      .locator("header nav a")
      .evaluateAll((els) => els.map((e) => e.getAttribute("href")));
    expect(navHrefs).toEqual(SECTION_IDS.map((id) => `#${id}`));
    const headed = await page.evaluate(() =>
      ["#work li", "#services li", "#process li"].map((sel) =>
        Array.from(document.querySelectorAll(sel)).map((li) => li.querySelectorAll("h3").length),
      ),
    );
    expect(headed).toEqual([
      [1, 1, 1, 1],
      [1, 1, 1, 1],
      [1, 1, 1, 1],
    ]);
  });

  test("M1-AC11 section boundaries sit at the design's scroll points", async ({ page }) => {
    await page.goto("/");
    const fractions = await page.evaluate((ids) => {
      const scrollable = document.documentElement.scrollHeight - window.innerHeight;
      return ids.map((id) => {
        const el = document.getElementById(id);
        return el ? (el.getBoundingClientRect().top + window.scrollY) / scrollable : -1;
      });
    }, SECTION_IDS);
    [0, 0.12, 0.3, 0.52, 0.68, 0.84].forEach((expected, i) => {
      expect(Math.abs((fractions[i] ?? -1) - expected)).toBeLessThanOrEqual(0.01);
    });
  });

  test("M1-AC8 copy deck strings are present and the foundation copy is gone", async ({ page }) => {
    await page.goto("/");
    const html = await page.evaluate(() => document.documentElement.innerHTML.replace(/\s+/g, " "));
    const strings = [
      "Phúc Lê",
      "Frame 01 · Hello",
      "Senior Frontend Developer · Ho Chi Minh City",
      "4+ years building React and TypeScript products. I've led a frontend team of 10 across Vietnam and Korea, set up Feature-Sliced Design architecture, and built a design system shared across projects.",
      "Start a project",
      "Frame 02 · Journey · contact sheet",
      "Hi, I'm Phúc — a senior frontend developer in Ho Chi Minh City. Right now I'm also studying for a second bachelor's, in Information Technology at Ho Chi Minh University of Science.",
      "Lê Đàm Duy Phúc",
      "Asia/Saigon (UTC+7)",
      "GBG Group Services",
      "Next.js and React with a team of 8 frontend engineers; GitHub CI/CD, Git hooks and linting across 2 projects; blue-green releases with Argo Rollouts.",
      "Led 10 frontend engineers with DevOps, design and backend across Vietnam and Korea; defined code review, Git and GitLab CI standards; onboarding down to 4 weeks.",
      "Feature-Sliced and Atomic Design architecture, a cross-project design system in Storybook + ArkUI, a monorepo of 11 packages and 6 apps, 10+ D3.js / Chart.js visualizations.",
      "React and Next.js frontends wired to Solidity smart contracts with web3.js; coordinated a 4-person team and was the main technical contact for customers.",
      "Frontend &amp; Blockchain Developer",
      "Bachelor of Information Technology",
      "Bachelor of Enterprise Resource Planning",
      "University of Economics Ho Chi Minh City",
      "TanStack Query",
      "Argo CD",
      "Frame 03 · Work · on the drying line",
      "A cross-project component library built on Atomic Design with Storybook and ArkUI, so every app shares the same component APIs and accessibility patterns.",
      "Brought 11 packages and 6 apps into one pnpm workspace with Turborepo, so teams could build in parallel without stepping on each other.",
      "A drag-and-drop page builder on Pragmatic DnD that streams large datasets in as JSON Lines.",
      "A monorepo of 8 developer CLI tools: git activity reports, AI code review, commit messages, port conflicts and mock data, powered by the Groq API.",
      "Frame 04 · Services · the chemistry",
      "From $500 USD · 7 days – 1 month · both depending on complexity",
      "A React / Next.js app or site from your design or brief, typed end to end, tested and deployed.",
      "Storybook-documented components your team can reuse, with consistent APIs and accessible patterns.",
      "Charts, big tables, uploads and builders with D3.js, Chart.js and TanStack Table.",
      "Feature-Sliced structure, pnpm + Turborepo, CI, linting and review rules for a growing codebase.",
      "From $500 USD",
      "typical delivery, depending on complexity",
      "Get a quote",
      "Frame 05 · Process",
      "Tell me what you want to build and by when. I reply within 4 hours.",
      "A written scope, price and timeline before any work starts.",
      "Work in small steps with a staging link and a demo every week.",
      "Deploy, docs and a code walkthrough, so your team owns it.",
      "Frame 06 · Contact · lights on",
      "Tell me what you're building. Freelance projects start from $500 USD (depending on complexity), usually 7 days – 1 month. Recruiting for a full-time role? Use the same form.",
      "linkedin.com/in/dp2907",
      "github.com/phucle297",
      "Freelance project",
      "Full-time role",
      "Your name",
      "you@company.com",
      "What are you building, and by when?",
      "Send brief",
      "I reply within 4 hours, Asia/Saigon (UTC+7).",
      "Please add your name.",
      "Please enter a valid email, like you@company.com.",
      "A sentence or two is enough.",
      "© 2026 Phúc Lê · Ho Chi Minh City",
      PUBLIC_EMAIL ?? "[Owner: email]",
    ];
    const missing = strings.filter((s) => !html.includes(s));
    expect(missing).toEqual([]);
    for (const stale of [
      "Software Engineer",
      "hello@example.com",
      "#0b0d12",
      ">About<",
      ">Projects<",
    ]) {
      expect(html).not.toContain(stale);
    }
  });

  test("email switch: PUBLIC_EMAIL drives the contact link, the form action and the mailto", async ({
    page,
  }) => {
    await page.goto("/");
    const contact = page.locator("#contact");
    if (PUBLIC_EMAIL === null) {
      await expect(contact.locator("[data-email]")).toHaveText("[Owner: email]");
      await expect(contact.locator('a[href^="mailto:"]')).toHaveCount(0);
      return;
    }
    const link = contact.locator(`[data-email] a[href="mailto:${PUBLIC_EMAIL}"]`);
    await expect(link).toHaveText(PUBLIC_EMAIL);
    await expect(contact.locator("form[data-contact-form]")).toHaveAttribute(
      "action",
      `mailto:${PUBLIC_EMAIL}`,
    );
    // Submitting a valid brief sends the browser to a prefilled mailto: for that address.
    const mailto = new Promise<string>((resolve) => {
      page.on("framenavigated", (frame) => {
        if (frame.url().startsWith("mailto:")) resolve(frame.url());
      });
      page.on("request", (request) => {
        if (request.url().startsWith("mailto:")) resolve(request.url());
      });
    });
    await page.fill("#contact-name", "Test Person");
    await page.fill("#contact-email", "test@example.com");
    await page.fill("#contact-brief", "A small marketing site by next month.");
    await contact.getByRole("button", { name: "Send brief" }).click();
    const url = await Promise.race([mailto, page.waitForTimeout(3000).then(() => "timeout")]);
    expect(url.startsWith(`mailto:${PUBLIC_EMAIL}?`)).toBe(true);
    expect(decodeURIComponent(url)).toContain("A small marketing site by next month.");
  });
});
