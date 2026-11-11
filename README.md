# portfolio

Personal portfolio of Phuc Le: a static-first [Astro](https://astro.build) site with a lazily
loaded [Three.js](https://threejs.org) hero and [Motion](https://motion.dev) UI animations, built
to stay fast (Lighthouse ≥ 95 in every category) and accessible.

> This repository currently contains the **foundation** only: layout, design tokens, the 3D hero
> island, scroll-reveal animations and placeholder content. Content marked `TODO` is placeholder.

## Requirements

- [Bun](https://bun.sh) `>= 1.3` as package manager and script runner (`packageManager` pins
  `bun@1.4.4`)
- Node.js `>= 22.23.4` (see `.nvmrc`). Astro 7 runs on Node; `bun run` executes the Astro CLI with
  Node via its shebang.

## Scripts

| Command                         | What it does                                                    |
| ------------------------------- | --------------------------------------------------------------- |
| `bun install --frozen-lockfile` | Install the exact dependency tree from `bun.lock`               |
| `bun run dev`                   | Start the dev server at `http://localhost:4321`                 |
| `bun run build`                 | Build the static site into `dist/`                              |
| `bun run preview`               | Serve the production build from `dist/` locally                 |
| `bun run check`                 | `astro check`: type-check `.astro` + `.ts` files (TypeScript 6) |
| `bun run typecheck`             | TypeScript 7 native compiler, `tsc --noEmit` on `.ts` files     |
| `bun run lint`                  | Oxlint, type-aware, warnings fail the run                       |
| `bun run lint:fix`              | Oxlint with autofix                                             |
| `bun run format`                | Format everything with oxfmt (including `.astro`)               |
| `bun run format:check`          | Verify formatting without writing                               |
| `bun run verify`                | check + typecheck + lint + format:check + build                 |

Set `SITE_URL` at build time to control canonical URLs, Open Graph URLs, `robots.txt` and the
sitemap (defaults to `https://phucle297.github.io`):

```sh
SITE_URL=https://example.dev bun run build
```

## Tooling notes

- **TypeScript 7 + TypeScript 6 side by side.** `typescript-7` is an npm alias for the stable
  native `typescript@7` compiler and powers `bun run typecheck`. TypeScript 7 no longer ships the
  JavaScript compiler API that `@astrojs/check` / Volar need (they require `typescript` `<7`), so
  `typescript@6` stays installed for `astro check`, which is the only checker that understands
  `.astro` files. Both bins are called `tsc`; the `typecheck` script calls the TS 7 launcher by
  path so there is no ambiguity.
- **Oxlint** (`.oxlintrc.json`) runs with type information via `oxlint-tsgolint`. In `.astro`
  files it lints the frontmatter and `<script>` blocks with syntax-only rules; type-aware rules
  apply to `.ts` files, and template markup/expressions are not linted.
- **oxfmt** (`.oxfmtrc.json`) formats `.astro` files via its embedded Astro printer, which needs
  `@astrojs/compiler-rs` (a dev dependency).

## Project structure

```text
.
├── astro.config.mjs          # Astro config: static output, sitemap, inlined CSS
├── .oxlintrc.json            # Oxlint config (typescript, import, unicorn, promise, jsx-a11y)
├── .oxfmtrc.json             # oxfmt config (Astro formatting enabled)
├── bun.lock                  # Bun text lockfile
├── tsconfig.json             # extends astro/tsconfigs/strictest, `@/*` -> `src/*`
├── public/                   # Copied as-is: favicons, og.png
└── src/
    ├── assets/images/        # Source images, optimised by astro:assets at build time
    ├── components/
    │   ├── sections/         # Page sections: Hero, About, Projects, Contact
    │   ├── three/            # HeroScene island (lazy WebGL loader + CSS poster)
    │   ├── Header.astro      # Sticky header, primary nav, CSS scroll-progress bar
    │   ├── Footer.astro
    │   ├── ProjectCard.astro # <Image> from astro:assets with responsive widths
    │   ├── Section.astro     # Section wrapper with accessible heading + reveal
    │   └── SkipLink.astro
    ├── layouts/
    │   └── BaseLayout.astro  # <html lang>, SEO/OG meta, font preload, landmarks, skip link
    ├── lib/
    │   ├── motion/           # Reduced-motion helpers, Motion scroll reveal
    │   ├── three/            # hero-scene.ts (three.js scene), webgl-support.ts (GPU probe)
    │   ├── projects.ts       # Project data (placeholder)
    │   └── site.ts           # Site-wide content: name, nav, socials, contact
    ├── pages/
    │   ├── index.astro
    │   ├── 404.astro
    │   └── robots.txt.ts     # robots.txt generated from SITE_URL
    └── styles/global.css     # Design tokens, base styles, utilities, reduced-motion rules
```

## How the performance budget is kept

- **Static HTML first.** Every page is pre-rendered; the hero text is plain HTML and is the LCP
  element. All CSS is inlined (it is small), so there are no render-blocking stylesheets.
- **Three.js is a lazy island.** `HeroScene.astro` shows a pure-CSS poster immediately. Only after
  `load`, when the browser is idle **and** the hero is on screen, does it `import()` the scene,
  so three.js (~130 kB gzip) lives in its own chunk that never blocks first paint.
- **The render loop is frugal.** It pauses when the hero is off screen (IntersectionObserver) or
  the tab is hidden, caps the pixel ratio at 1.5, compiles shaders with `compileAsync`, and
  disposes geometries, materials and the renderer on teardown.
- **No 3D on software WebGL.** If the GPU probe finds a software rasteriser (SwiftShader,
  llvmpipe, …) or `failIfMajorPerformanceCaveat` fails, or Save-Data is on, three.js is never
  downloaded and the poster stays.
- **Motion, small.** Scroll reveals use `inView` from `motion` and `animate` from `motion/mini`
  (WAAPI-based), ~3.7 kB gzip for the whole layout script.
- **Fonts.** Inter Variable is self-hosted via `@fontsource-variable/inter` with
  `font-display: swap`; the Latin subset is preloaded and a metric-matched Arial fallback avoids
  layout shift.
- **Images.** `astro:assets` generates responsive WebP variants with `srcset`/`sizes`, lazy loading
  and intrinsic dimensions.

## Accessibility and reduced motion

- `lang` attribute, skip link, `header`/`nav`/`main`/`footer` landmarks, labelled sections,
  visible focus rings, colour contrast that passes WCAG AA.
- `prefers-reduced-motion: reduce` is respected everywhere: scroll reveals are disabled (content is
  visible immediately), CSS transitions/animations are neutralised, smooth scrolling is turned off,
  and the 3D hero paints a single static frame instead of animating. Content never depends on JS:
  reveal styles only apply when an inline script confirms JS is running and motion is allowed.

## Deployment

No CI/CD is configured yet. `dist/` is a plain static site that can be hosted on any static host.
