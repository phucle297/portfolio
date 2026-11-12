# shared/lib

Internal libraries, one focused area each, each with its own public API (`index.ts`):

- `motion`: motion preferences: the OS `prefers-reduced-motion` query plus the site's Motion
  toggle (persisted in `localStorage`), and a change event for both.
- `timeline`: the single scroll timeline (sections, holds, per-track `TIMING`, easing, `locate`)
  shared by the 3D scene and the page. Pure data and functions.
- `webgl`: hardware-WebGL2 detection (software-renderer check, off-main-thread probe in a Worker).

Import them as `@shared/lib/<name>`; never import a file inside a library directly.
