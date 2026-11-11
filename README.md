# portfolio

Personal portfolio of Phuc Le: a static-first [Astro](https://astro.build) site with a lazily
loaded [Three.js](https://threejs.org) hero and [Motion](https://motion.dev) UI animations, built
to stay fast (Lighthouse ≥ 95 in every category) and accessible.

> This repository currently contains the **foundation** only: layout, design tokens, the 3D hero
> island, scroll-reveal animations and placeholder content. Content marked `TODO` is placeholder.

## Requirements

- Node.js `>= 22.23.4` (see `.nvmrc`; required by Astro 7)
- npm `>= 10`

## Scripts

| Command                | What it does                                               |
| ---------------------- | ---------------------------------------------------------- |
| `npm ci`               | Install the exact dependency tree from `package-lock.json` |
| `npm run dev`          | Start the dev server at `http://localhost:4321`            |
| `npm run build`        | Build the static site into `dist/`                         |
| `npm run preview`      | Serve the production build from `dist/` locally            |
| `npm run check`        | Type-check `.astro` and `.ts` files (`astro check`)        |
| `npm run lint`         | ESLint (flat config, zero warnings allowed)                |
| `npm run lint:fix`     | ESLint with autofix                                        |
| `npm run format`       | Format everything with Prettier                            |
| `npm run format:check` | Verify formatting without writing                          |

Set `SITE_URL` at build time to control canonical URLs, Open Graph URLs, `robots.txt` and the
sitemap (defaults to `https://phucle297.github.io`):

```sh
SITE_URL=https://example.dev npm run build
```

## Project structure

```text
.
├── astro.config.mjs          # Astro config: static output, sitemap, inlined CSS
├── eslint.config.js          # ESLint flat config (typescript-eslint strict + eslint-plugin-astro)
├── .prettierrc.json          # Prettier + prettier-plugin-astro
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
