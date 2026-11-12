/**
 * The component preview (/ui-preview/) is a dev and PR-preview tool, never a production page
 * (PF-28, CL-Q1). It is built only by `astro dev` and by builds that set PUBLIC_UI_PREVIEW=1 (the
 * pull_request build in .github/workflows/deploy.yml). A plain `bun run build` emits no file for
 * it, so production serves the 404 page there and the sitemap cannot list it.
 *
 * Production guard: a GitHub Actions build for a push, or for refs/heads/main, never builds it,
 * even with PUBLIC_UI_PREVIEW=1, so the prod deploy path cannot turn it on by mistake.
 */
export const UI_PREVIEW_PATH = "/ui-preview/";

export interface UiPreviewEnv {
  DEV: boolean;
  PUBLIC_UI_PREVIEW?: string | undefined;
  /** GitHub Actions' GITHUB_EVENT_NAME and GITHUB_REF, when building in CI. */
  GITHUB_EVENT_NAME?: string | undefined;
  GITHUB_REF?: string | undefined;
}

export function isProductionCiBuild(env: UiPreviewEnv): boolean {
  return env.GITHUB_EVENT_NAME === "push" || env.GITHUB_REF === "refs/heads/main";
}

export function uiPreviewEnabled(env: UiPreviewEnv): boolean {
  if (isProductionCiBuild(env)) return false;
  return env.DEV || env.PUBLIC_UI_PREVIEW === "1";
}
