/**
 * Page copy for the home page: the round-7 Darkroom Morph copy deck (design.md §5), all sourced
 * from the owner's CV. Nothing here is invented. Every owner question is answered or ships its
 * build plan §4 default, so no `[Owner: …]` placeholder text ships (M4-AC1).
 */
import { profile } from "./profile";

export interface Role {
  years: string;
  company: string;
  title: string;
  copy: string;
}

export interface Education {
  degree: string;
  school: string;
  years: string;
}

export interface WorkCase {
  title: string;
  context: string;
  copy: string;
  tags: string;
  /** TODO(owner): case URL. The "Read the case" link is hidden while null (build plan Q4). */
  href: string | null;
}

export interface Service {
  title: string;
  copy: string;
}

export interface ProcessStep {
  eyebrow: string;
  title: string;
  copy: string;
}

/** Reply-time promise (Owner decision, replaces the plan's Q3 default). Used verbatim. */
export const REPLY_WINDOW = "I reply within 4 hours";

/**
 * The reply promise with its time zone, worded the same everywhere it is made: Process step 1,
 * the form note and the success text (build plan Q3, M4-AC1).
 */
export const REPLY_PROMISE = `${REPLY_WINDOW}, ${profile.timezone}`;

export const hello = {
  eyebrow: "Frame 01 · Hello",
  title: "Phúc Lê,",
  titleAccent: "developing.",
  subtitle: "Senior Frontend Developer · Ho Chi Minh City",
  lede: "4+ years building React and TypeScript products. I've led a frontend team of 10 across Vietnam and Korea, set up Feature-Sliced Design architecture, and built a design system shared across projects.",
  primaryCta: "Start a project",
  /** Shown when `profile.cvUrl` is set. */
  secondaryCta: "Download CV",
  /** Shown until a public CV exists (build plan Q9): opens LinkedIn. */
  secondaryCtaFallback: "CV on LinkedIn",
  scrollCue: "Scroll to develop the roll ↓",
} as const;

export const journey = {
  eyebrow: "Frame 02 · Journey · contact sheet",
  title: "Four frames,",
  titleAccent: "2022 → now",
  intro:
    "Hi, I'm Phúc — a senior frontend developer in Ho Chi Minh City. Right now I'm also studying for a second bachelor's, in Information Technology at Ho Chi Minh University of Science.",
} as const;

/** Newest first, as shown on the page. */
export const roles: readonly Role[] = [
  {
    years: "2026 – now",
    company: "GBG Group Services",
    title: "Senior Frontend Developer",
    copy: "Next.js and React with a team of 8 frontend engineers; GitHub CI/CD, Git hooks and linting across 2 projects; blue-green releases with Argo Rollouts.",
  },
  {
    years: "2025 – 2026",
    company: "Nexon Dev Vina",
    title: "Team Leader",
    copy: "Led 10 frontend engineers with DevOps, design and backend across Vietnam and Korea; defined code review, Git and GitLab CI standards; onboarding down to 4 weeks.",
  },
  {
    years: "2023 – 2025",
    company: "Nexon Dev Vina",
    title: "Middle Frontend Developer",
    copy: "Feature-Sliced and Atomic Design architecture, a cross-project design system in Storybook + ArkUI, a monorepo of 11 packages and 6 apps, 10+ D3.js / Chart.js visualizations.",
  },
  {
    years: "2022 – 2023",
    company: "MLTech Soft",
    title: "Frontend & Blockchain Developer",
    copy: "React and Next.js frontends wired to Solidity smart contracts with web3.js; coordinated a 4-person team and was the main technical contact for customers.",
  },
];

export const education: readonly Education[] = [
  {
    degree: "Bachelor of Information Technology",
    school: "Ho Chi Minh University of Science",
    years: "2024 – now",
  },
  {
    degree: "Bachelor of Enterprise Resource Planning",
    school: "University of Economics Ho Chi Minh City",
    years: "2019 – 2023",
  },
];

export const skills: readonly string[] = [
  "React",
  "TypeScript",
  "Next.js",
  "Feature-Sliced Design",
  "Monorepo",
  "Turborepo",
  "Storybook",
  "TanStack Query",
  "Zustand",
  "Zod",
  "D3.js",
  "Web Workers",
  "Vitest",
  "Cypress",
  "GitHub CI/CD",
  "Argo CD",
];

export const work = {
  eyebrow: "Frame 03 · Work · on the drying line",
  title: "Prints on",
  titleAccent: "the line",
  readCase: "Read the case →",
  cases: [
    {
      title: "Design system",
      context: "Nexon Dev Vina · 2023 – 2025",
      copy: "A cross-project component library built on Atomic Design with Storybook and ArkUI, so every app shares the same component APIs and accessibility patterns.",
      tags: "Storybook · ArkUI · React",
      href: null,
    },
    {
      title: "Monorepo",
      context: "Nexon Dev Vina · 2023 – 2025",
      copy: "Brought 11 packages and 6 apps into one pnpm workspace with Turborepo, so teams could build in parallel without stepping on each other.",
      tags: "pnpm · Turborepo · FSD",
      href: null,
    },
    {
      title: "Drag-and-drop builder",
      context: "Nexon Dev Vina · 2023 – 2025",
      copy: "A drag-and-drop page builder on Pragmatic DnD that streams large datasets in as JSON Lines.",
      tags: "Pragmatic DnD · Streaming · JSON Lines",
      href: null,
    },
    {
      title: "Toolkit",
      context: "Personal project · 2025 – now",
      copy: "A monorepo of 8 developer CLI tools: git activity reports, AI code review, commit messages, port conflicts and mock data, powered by the Groq API.",
      tags: "Python · Typer · Groq",
      href: null,
    },
  ] satisfies WorkCase[],
} as const;

export const services = {
  eyebrow: "Frame 04 · Services · the chemistry",
  title: "What I can",
  titleAccent: "develop for you",
  subline: "From $500 USD · 7 days – 1 month · both depending on complexity",
  items: [
    {
      title: "Web app build",
      copy: "A React / Next.js app or site from your design or brief, typed end to end, tested and deployed.",
    },
    {
      title: "Design system & component library",
      copy: "Storybook-documented components your team can reuse, with consistent APIs and accessible patterns.",
    },
    {
      title: "Dashboards & data-heavy UIs",
      copy: "Charts, big tables, uploads and builders with D3.js, Chart.js and TanStack Table.",
    },
    {
      title: "Frontend architecture & monorepo setup",
      copy: "Feature-Sliced structure, pnpm + Turborepo, CI, linting and review rules for a growing codebase.",
    },
  ] satisfies Service[],
  price: { label: "Price", value: "From $500 USD", note: "depending on complexity" },
  timeline: {
    label: "Timeline",
    value: "7 days – 1 month",
    note: "typical delivery, depending on complexity",
  },
  cta: "Get a quote",
} as const;

export const process = {
  eyebrow: "Frame 05 · Process",
  title: "Develop, stop,",
  titleAccent: "fix, dry",
  steps: [
    {
      eyebrow: "Develop",
      title: "Brief",
      copy: `Tell me what you want to build and by when. ${REPLY_PROMISE}.`,
    },
    {
      eyebrow: "Stop",
      title: "Quote & plan",
      copy: "A written scope, price and timeline before any work starts.",
    },
    {
      eyebrow: "Fix",
      title: "Build",
      copy: "Work in small steps with a staging link and a demo every week.",
    },
    {
      eyebrow: "Dry",
      title: "Launch & handover",
      copy: "Deploy, docs and a code walkthrough, so your team owns it.",
    },
  ] satisfies ProcessStep[],
} as const;

export const contact = {
  eyebrow: "Frame 06 · Contact · lights on",
  title: "Start a",
  titleAccent: "project",
  copy: "Tell me what you're building. Freelance projects start from $500 USD (depending on complexity), usually 7 days – 1 month. Recruiting for a full-time role? Use the same form.",
  form: {
    modes: ["Freelance project", "Full-time role"],
    name: { label: "Name", placeholder: "Your name" },
    email: { label: "Email", placeholder: "you@company.com" },
    projectType: {
      label: "Project type",
      options: [
        "Web app build",
        "Design system & component library",
        "Dashboards & data-heavy UIs",
        "Frontend architecture & monorepo setup",
        "Something else",
      ],
    },
    brief: { label: "Short brief", placeholder: "What are you building, and by when?" },
    submit: "Send brief",
    note: `${REPLY_PROMISE}.`,
    /** Visible only when JS is off. Points at the mailto link in .contact__links. */
    noJsNote: "JavaScript is off — send a brief using the email address above.",
    errors: {
      name: "Please add your name.",
      email: "Please enter a valid email, like you@company.com.",
      brief: "A sentence or two is enough.",
    },
    /**
     * Build plan Q8: the form opens a prefilled mailto:, so design.md's "Thanks — your brief is
     * in." would overclaim. The success line says what actually happened.
     */
    success: `Your email app is open with your brief. ${REPLY_PROMISE}.`,
    /**
     * Shown on submit only while `PUBLIC_EMAIL` is null (the address is public, so not at
     * launch). Plain copy: no `[Owner: …]` token ships in the HTML even in this unused message.
     */
    noEmail: "Email sending isn't switched on yet. Please reach me on LinkedIn for now.",
    copyEmail: "Copy email",
    copied: "Email copied.",
    copyFailed: "Couldn't copy. The address is selected, press Ctrl+C or ⌘C.",
  },
} as const;

/** Visually hidden description of the decorative canvas (design.md §9). */
export const sceneDescription =
  "Decorative animation: a photo darkroom that changes as you scroll. A print of Phúc Lê's name develops in a tray, splits into a contact sheet of his roles, hangs on a drying line as his work, becomes labels on four amber bottles for his services, settles into four trays for his process, and joins back into one print when the lights come on at Contact. All content is in the page text.";

/**
 * Text drawn into the in-scene print textures. It duplicates DOM copy and is never the only
 * source (design.md §5 "In-scene text").
 */
export const sceneText = {
  intro: {
    name: "PHÚC LÊ",
    role: "SENIOR FRONTEND DEVELOPER · HO CHI MINH CITY",
  },
  frames: [
    ["2022", "MLTECH SOFT"],
    ["2023", "NEXON · MIDDLE FE"],
    ["2025", "NEXON · TEAM LEAD"],
    ["2026", "GBG GROUP"],
  ],
  cases: [
    ["DESIGN SYSTEM", "STORYBOOK · ARKUI"],
    ["MONOREPO", "11 PACKAGES · 6 APPS"],
    ["DND BUILDER", "PRAGMATIC DND · JSONL"],
    ["TOOLKIT", "8 CLI TOOLS · GROQ"],
  ],
  labels: ["WEB APP", "DESIGN SYS", "DASHBOARDS", "ARCHITECTURE"],
  price: "FROM $500 · 7 DAYS – 1 MONTH",
  steps: [
    ["01", "DEVELOP", "BRIEF"],
    ["02", "STOP", "QUOTE & PLAN"],
    ["03", "FIX", "BUILD"],
    ["04", "DRY", "LAUNCH"],
  ],
  timer: ["FROM $500", "7 DAYS – 1 MONTH"],
  contact: ["START A", "PROJECT"],
} as const;
