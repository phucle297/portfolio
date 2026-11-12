import type { AstroComponentFactory } from "astro/runtime/server/index.js";

/**
 * Every `*.preview.astro` next to a component in src/shared/ui is picked up here, so adding a
 * component and its preview touches no other component's files (PF-28 AC4). The file name is the
 * section title; sections sort by it, with tokens first.
 */
const modules = import.meta.glob<{ default: AstroComponentFactory }>(
  "/src/shared/ui/**/*.preview.astro",
  { eager: true },
);

export interface Preview {
  id: string;
  title: string;
  Component: AstroComponentFactory;
}

const titleOf = (path: string): string =>
  (path.split("/").pop() ?? path).replace(/\.preview\.astro$/u, "");

export const previews: Preview[] = Object.entries(modules)
  .map(([path, mod]) => ({
    id: titleOf(path).toLowerCase(),
    title: titleOf(path),
    Component: mod.default,
  }))
  .toSorted((a, b) =>
    a.id === "tokens" ? -1 : b.id === "tokens" ? 1 : a.title.localeCompare(b.title),
  );
