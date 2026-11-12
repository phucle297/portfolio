/**
 * The component preview (/ui-preview/) is a dev and PR-preview tool, never a production page
 * (PF-28, CL-Q1). It is built only by `astro dev` and by builds that set PUBLIC_UI_PREVIEW=1
 * (the pull_request build in .github/workflows/deploy.yml); a plain `bun run build` (production)
 * emits no file for it, so prod serves the 404 page there and the sitemap cannot list it.
 */
export const UI_PREVIEW_PATH = "/ui-preview/";

export function uiPreviewEnabled(env: { DEV: boolean; PUBLIC_UI_PREVIEW?: string }): boolean {
  return env.DEV || env.PUBLIC_UI_PREVIEW === "1";
}
