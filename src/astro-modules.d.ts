/**
 * Ambient type for `.astro` imports, used by the plain TypeScript compiler (`bun run typecheck`,
 * TypeScript 7), which cannot parse Astro components. `astro check` resolves the real files and
 * their precise prop types instead; this declaration only kicks in when a `.astro` file cannot
 * be resolved by the compiler in use.
 */
declare module "*.astro" {
  import type { AstroComponentFactory } from "astro/runtime/server/index.js";

  const Component: AstroComponentFactory;
  export default Component;
}
