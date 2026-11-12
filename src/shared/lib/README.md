# shared/lib

Internal libraries, one focused area each, each with its own public API (`index.ts`):

- `motion`: reduced-motion preference helpers (media query, live `MediaQueryList`).
- `webgl`: hardware-WebGL detection (software-renderer check, off-main-thread probe in a Worker).

Import them as `@shared/lib/<name>`; never import a file inside a library directly.
