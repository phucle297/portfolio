# portfolio

Personal portfolio of Phúc Lê: a static-first [Astro](https://astro.build) site built to the
approved **Darkroom Morph** design: one persistent, lazily loaded [Three.js](https://threejs.org)
scene (a photo darkroom) behind the whole page, driven by scroll, over a plain-HTML copy layer.
Built to stay fast (Lighthouse ≥ 95 in every category) and accessible.

> Milestone **M1** (scene + copy layer). Values the owner has not supplied yet render as visible
> `[Owner: …]` placeholders; see [Owner content](#owner-content-and-the-email-switch).

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
| `bun run test`                  | Unit tests (Vitest): timeline, key states, scene graph          |
| `bun run test:e2e`              | End-to-end tests (Playwright) against `build` + `preview`       |
| `bun run verify`                | check + typecheck + lint + format:check + test + build          |
| `bun run prepare`               | Install Lefthook git hooks (runs automatically on install)      |

Set `SITE_URL` at build time to control canonical URLs, Open Graph URLs, `robots.txt` and the
sitemap (defaults to `https://phucle297.github.io`):

```sh
SITE_URL=https://example.dev bun run build
```

`test:e2e` builds the site and serves it on port 4322. On a machine without Playwright's own
browser download, point it at an installed Chrome: `CHROME_PATH=/usr/bin/google-chrome bun run
test:e2e`. Tests that need the full 3D tier stub the hardware-WebGL probe and render on
SwiftShader, so they check behaviour, not GPU performance.

## Owner content and the email switch

All copy lives in one content module, `src/entities/profile/model/content.ts` (plus
`profile.ts`), sourced from the owner's CV. Launch defaults from the build plan:

| Question                      | Shipped default                                                          |
| ----------------------------- | ------------------------------------------------------------------------ |
| Photo                         | none: the Journey slot shows the name / city / time zone meta only       |
| Public email                  | **off**: `[Owner: email]` placeholder, see below                         |
| Reply window                  | "within 2 business days" (`REPLY_WINDOW`)                                |
| Case screenshots / case pages | no screenshots; "Read the case" links hidden until `href` is set         |
| Mobile                        | static stills (`LITE_MORPH_ENABLED = false`)                             |
| Contact form                  | client-side validation, then a prefilled `mailto:` (needs the email)     |
| CV PDF                        | not published (it has a phone number): the button reads "CV on LinkedIn" |

**The email is behind one switch:** `PUBLIC_EMAIL` in `src/shared/config/contact.ts`. While it
is `null` (the default, because the owner has not confirmed showing an address publicly) the
page shows `[Owner: email]`, and submitting the contact form explains that sending is not
switched on yet. Set it to an address and the contact link, the form's `mailto:` and the no-JS
form action all use it; nothing else changes.

After changing anything drawn in the scene (or to refresh the poster stills), re-render the stills
from the shipped scene: `bun run build && bun run preview -- --port 4321 &` then
`CHROME_PATH=/usr/bin/google-chrome node tools/render-stills.mjs`.

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
│   │   ├── ui/                 #   HomePage, six section components, SectionStill (poster AVIFs
│   │   │                       #   from ui/stills/), SectionRail, DarkroomScene (the 3D loader)
│   │   ├── model/              #   keyframes.ts (K[0..5], design.md §4), evaluate.ts (pure
│   │   │                       #   p → scene state)
│   │   ├── lib/                #   gate.ts + tiers.ts (initial bundle); stage.ts, darkroom.ts,
│   │   │                       #   scene-graph.ts, atlases.ts, tile-material.ts (lazy chunk);
│   │   │                       #   section-tracker.ts, contact-form.ts
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
│   └── profile/                #   model/profile.ts (owner facts) + model/content.ts (copy deck)
└── shared/                     # shared layer, no slices; one public API per segment
    ├── config/                 #   site metadata + navigation, PUBLIC_EMAIL switch (index.ts)
    ├── ui/                     #   SkipLink (index.ts)
    └── lib/                    #   one public API per library (see shared/lib/README.md)
        ├── motion/             #     reduced-motion + Motion toggle preference
        ├── timeline/           #     the one scroll timeline (sections, holds, TIMING, easing)
        └── webgl/              #     hardware-WebGL2 detection, Worker probe
```

Why things live where they do:

- **The darkroom scene** is only used by the home page, so it stays in the `home` page slice
  (Steiger's `insignificant-slice` rule rejects a `widgets/darkroom-scene` slice with a single
  reference). Extract it to `widgets` once a second page needs it.
- **The timeline** (`shared/lib/timeline`) is pure data shared by the scene and the page (nav
  highlight, rail), with no business meaning, so it is shared.
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

- **Static HTML first.** Every page is pre-rendered; all copy is plain HTML. All CSS is inlined,
  so there are no render-blocking stylesheets.
- **Static tier by default.** Each section shows an AVIF poster still of the same scene at its
  key state (`astro:assets`, ≈ 9–23 kB each desktop, ≈ 3–7 kB mobile). The first still is eager
  with `fetchpriority="high"`; the others are lazy and are never fetched on the full tier.
- **Gates before any download (F1).** `DarkroomScene.astro` requests nothing until the page has
  loaded and the browser is idle (or on first input), and then only if **all** cheap gates pass:
  `(pointer: fine)`, viewport ≥ 768 px, no `prefers-reduced-motion`, the Motion toggle is on and
  Save-Data is off. Only then does the hardware-WebGL2 probe run in a Worker; only if it passes is
  the three.js + scene chunk (~141 kB gzip) imported. Under reduced motion neither the probe nor
  three.js is ever requested.
- **One renderer, one scene, one canvas** for the whole page, `position: fixed` behind the copy.
  Every object is built once; `set(p)` only copies a pure `evaluate(p)` result onto it.
- **Render on demand.** Frames render only while the scene is catching up with the scroll
  position (one damped catch-up, ≈ GSAP `scrub: .6`); nothing renders when idle or when the tab is
  hidden. DPR is capped at 1.5 (1.0 on the lite tier); no shadows, no post-processing.
- **Small textures.** The six print atlases are drawn at runtime from fonts (0 kB download) at
  1536 px wide and stored as single-channel R8 (the shader reads one channel): ≈ 14.8 MiB of
  texture memory including mipmaps, vs ≈ 54 MB budgeted for RGBA.
- **Fonts.** Be Vietnam Pro, Instrument Serif and IBM Plex Mono are self-hosted via `@fontsource`
  with `unicode-range` subsets (only used ranges download); the H1 faces are preloaded; metric
  overrides on local fallbacks limit layout shift. Anton is declared but only used by the 3D
  island's textures, so static-tier visitors never download it.

## Accessibility and reduced motion

- `lang` attribute, skip link, `header`/`nav`/`main`/`footer` landmarks, a separate
  `nav[aria-label="Sections"]` rail with `aria-current`, labelled sections, visible focus rings,
  WCAG AA contrast with scrims behind text over the scene.
- The canvas is `aria-hidden`, preceded by a visually hidden description of the animation.
- **Motion toggle** (WCAG 2.2.2) in the header: switches the full tier to the poster stills
  without a reload and persists in `localStorage` (`motion` = `off`). It follows
  `prefers-reduced-motion` by default; under reduced motion it stays off.
- `prefers-reduced-motion: reduce`: no three.js, no probe, no scroll reveals, transitions
  neutralised. Content never depends on JS.

### Test hook

`window.darkroomTest = { set(p), state(), info(), frames(), tier }` is exposed only in dev or when
the URL has `?scene-test` (the build plan's `__darkroom`, renamed because `no-underscore-dangle`
is enforced). `?scene-test&tier=lite` forces the lite tier for measurement.

## Deployment

No CI/CD is configured yet. `dist/` is a plain static site that can be hosted on any static host.
