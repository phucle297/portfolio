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
| `bun run lint`                  | `lint:oxlint` then `lint:fsd` (both must pass)                  |
| `bun run lint:oxlint`           | Oxlint, type-aware + local FSD import rules, warnings fail      |
| `bun run lint:fsd`              | Steiger (official FSD linter), warnings fail                    |
| `bun run lint:fix`              | Oxlint with autofix                                             |
| `bun run format`                | Format everything with oxfmt (including `.astro`)               |
| `bun run format:check`          | Verify formatting without writing                               |
| `bun run verify`                | check + typecheck + lint + format:check + build                 |
| `bun run prepare`               | Install Lefthook git hooks (runs automatically on install)      |

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
- **Oxlint** (`.oxlintrc.json`) runs with type information via `oxlint-tsgolint`, plus the local
  `fsd-imports` JS plugin (`tools/oxlint-plugin-fsd`). In `.astro` files it lints the frontmatter
  and `<script>` blocks (syntax rules and the FSD import rules; type-aware rules only run on
  `.ts` files); template markup/expressions are not linted.
- **Steiger** (`steiger.config.js`, recommended FSD ruleset) checks the folder structure and
  imports. `@steiger/toolkit` is a direct dev dependency only because the plugin's type
  declarations import it without declaring it.
- **oxfmt** (`.oxfmtrc.json`) formats `.astro` files via its embedded Astro printer, which needs
  `@astrojs/compiler-rs` (a dev dependency).

## Git hooks (Lefthook)

`bun install` runs the `prepare` script (`tools/install-git-hooks.mjs`), which runs
`lefthook install`. It skips quietly when there is no git repository, when `LEFTHOOK=0`, or when
Lefthook is not installed, so it never breaks an install. Hooks are defined in `lefthook.yml`:

- **pre-commit** (staged files only): `oxfmt` formats staged files and re-stages them
  (`stage_fixed`), `oxlint` lints staged JS/TS/Astro files, and Steiger checks the architecture
  when anything under `src/` is staged.
- **pre-push**: `typecheck` (TS 7), `astro check`, full `lint` (oxlint + Steiger),
  `format:check` (oxfmt), `build`.

Skip once with `LEFTHOOK=0 git commit …` (use sparingly).

## Architecture: Feature-Sliced Design

The code follows [Feature-Sliced Design](https://fsd.how) (FSD) with the official
[Astro adaptation](https://fsd.how/docs/guides/tech/with-astro/): Astro owns `src/pages` for
file-based routing, so the FSD **pages** layer lives in `src/_pages`. Route files stay thin: they
pick a layout from `app` and render a page from `_pages`. Steiger recognises the `_` prefix, so
`src/_pages` is linted as the pages layer and `src/pages` is not treated as one.

```text
src/
├── pages/                      # Astro routes only (thin): index.astro, 404.astro, robots.txt.ts
├── app/                        # app layer, no slices
│   ├── entrypoint/client.ts    #   client bootstrap (scroll reveal), loaded by BaseLayout
│   ├── layouts/                #   BaseLayout.astro: <html>, SEO meta, font preload, header/footer
│   └── styles/global.css       #   design tokens, base styles, reduced-motion rules
├── _pages/                     # pages layer (FSD), one slice per page
│   ├── home/
│   │   ├── ui/                 #   HomePage + Hero/About/Projects/Contact sections, ProjectCard,
│   │   │                       #   HeroBackdrop (lazy 3D island + CSS poster)
│   │   ├── lib/hero-scene.ts   #   three.js scene (own lazy chunk, only via dynamic import())
│   │   ├── model/              #   projects.ts (placeholder data) + covers/*.webp
│   │   └── index.ts            #   public API: HomePage
│   └── not-found/
│       ├── ui/NotFoundPage.astro
│       ├── config/meta.ts      #   title/description for the 404 route
│       └── index.ts
├── widgets/                    # widgets layer
│   ├── site-header/            #   ui/SiteHeader.astro + index.ts
│   └── site-footer/            #   ui/SiteFooter.astro + index.ts
├── features/                   # features layer
│   └── reveal-on-scroll/       #   ui/reveal.ts (Motion inView + motion/mini) + index.ts
├── entities/                   # entities layer
│   └── profile/                #   model/profile.ts (owner name, role, email, socials) + index.ts
└── shared/                     # shared layer, no slices; one public API per segment
    ├── config/                 #   site metadata + navigation (index.ts)
    ├── ui/                     #   Section, SkipLink (index.ts)
    └── lib/                    #   one public API per library (see shared/lib/README.md)
        ├── motion/             #     reduced-motion helpers
        └── webgl/              #     hardware-WebGL detection, Worker probe
```

Why things live where they do:

- **Hero 3D scene and projects** are only used by the home page, so they stay in the `home`
  page slice (FSD keeps screen-specific compositions in pages; Steiger's
  `insignificant-slice` rule flags single-use slices). Extract them to `widgets`/`entities` once
  a second page needs them.
- **Header and footer** are app-wide blocks composed by the app layout, so they are widgets.
- **Scroll reveal** is a cross-page interaction, so it is a feature; the app entrypoint wires it.
- **GPU probe and reduced-motion helpers** have no business meaning, so they are `shared/lib`.
- **Owner identity** (`profile`) is the one business entity used by several layers.

### Path aliases

| Alias         | Folder           | Layer    |
| ------------- | ---------------- | -------- |
| `@app/*`      | `src/app/*`      | app      |
| `@pages/*`    | `src/_pages/*`   | pages    |
| `@widgets/*`  | `src/widgets/*`  | widgets  |
| `@features/*` | `src/features/*` | features |
| `@entities/*` | `src/entities/*` | entities |
| `@shared/*`   | `src/shared/*`   | shared   |

Defined in `tsconfig.json` (`compilerOptions.paths`); Astro/Vite pick them up from there.
`src/astro-modules.d.ts` lets the plain TypeScript compiler see `.astro` default exports
re-exported from `index.ts` files (`astro check` uses the real component types).

### Import rules

1. **Layers:** a module imports only from layers strictly below it
   (`app > pages > widgets > features > entities > shared`; routes in `src/pages` may import any
   layer). `app` and `shared` segments may use each other.
2. **No cross-slice imports:** slices on the same layer do not import each other (entities may
   use the `@x` cross-import API, `entities/A/@x/B.ts`, if ever needed).
3. **Public API only:** from outside a slice, import its `index.ts` (`@entities/profile`), never a
   file inside it (`@entities/profile/model/profile`). In `shared`, each segment (`@shared/ui`,
   `@shared/config`) and each library (`@shared/lib/webgl`) has its own `index.ts`.
4. **Aliases across boundaries, relative inside:** imports that leave a slice/segment use the
   aliases above; imports inside a slice are relative (`../model/projects`). A slice never imports
   itself through its own alias (that creates circular imports through `index.ts`).

### How the rules are enforced

| Rule                                                              | Oxlint (`tools/oxlint-plugin-fsd`)                | Steiger (`steiger.config.js`)           |
| ----------------------------------------------------------------- | ------------------------------------------------- | --------------------------------------- |
| 1. Layers                                                         | `.ts`/`.js`, `.astro` frontmatter + `<script>`    | `.ts`/`.js`, `.astro` frontmatter only  |
| 2. Cross-slice                                                    | `.ts`/`.js`, `.astro` frontmatter + `<script>`    | `.ts`/`.js`, `.astro` frontmatter only  |
| 3. Public API                                                     | slices and shared segments/libs, all of the above | slices only (not shared), no `<script>` |
| 4. Aliases/relative                                               | all of the above                                  | not covered                             |
| Structure (naming, segments, public-api files, single-use slices) | –                                                 | yes (full recommended ruleset)          |

The local Oxlint plugin resolves aliases and relative paths to the layer/slice they point at;
Steiger adds FSD structure checks. Template expressions in `.astro` cannot contain imports, so
frontmatter + `<script>` covers every import in the project.

## How the performance budget is kept

- **Static HTML first.** Every page is pre-rendered; the hero text is plain HTML and is the LCP
  element. All CSS is inlined (it is small), so there are no render-blocking stylesheets.
- **Three.js is a lazy island.** `HeroBackdrop.astro` (in `_pages/home/ui`) shows a pure-CSS poster immediately. Only after
  `load`, when the browser is idle **and** the hero is on screen, does it `import()` the scene,
  so three.js (~130 kB gzip) lives in its own chunk that never blocks first paint.
- **The render loop is frugal.** It pauses when the hero is off screen (IntersectionObserver) or
  the tab is hidden, caps the pixel ratio at 1.5, compiles shaders with `compileAsync`, and
  disposes geometries, materials and the renderer on teardown.
- **No 3D on software WebGL.** If the GPU probe finds a software rasteriser (SwiftShader,
  llvmpipe, …) or `failIfMajorPerformanceCaveat` fails, or Save-Data is on, three.js is never
  downloaded and the poster stays. The probe runs in a Web Worker on an `OffscreenCanvas`, so
  creating the test context never blocks the main thread.
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
