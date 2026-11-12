// @ts-check
/**
 * Local Oxlint JS plugin enforcing Feature-Sliced Design import rules for this repo.
 *
 * Runs on .ts/.js files and on .astro files (Oxlint lints both the frontmatter and <script>
 * blocks). Rules:
 *   fsd-imports/layers            (a) a layer imports only from layers strictly below it
 *   fsd-imports/no-cross-slice    (b) no imports between slices of the same layer (except @x)
 *   fsd-imports/public-api        (c) code outside a slice imports only its public API (index.ts)
 *   fsd-imports/relative-in-slice (d) relative imports stay inside the slice; cross-slice/layer
 *                                     imports use path aliases, and a slice never imports itself
 *                                     through its own alias
 *
 * "Unit" = the thing that owns a public API: a slice on sliced layers (entities, features,
 * widgets, pages), a segment on shared (or one library under shared/lib) and a segment on app.
 * App segments may import each other relatively (app is the composition root and nothing but
 * routes imports it). Astro routes in src/pages sit above everything (thin entry points).
 */
import path from "node:path";
import { definePlugin, defineRule } from "@oxlint/plugins";

/** @import { Context, ESTree } from "@oxlint/plugins" */

const SRC = path.resolve(import.meta.dirname, "../../src");

/** Lowest to highest. `routes` = Astro's src/pages, above the FSD app layer. */
const LAYER_RANK = { shared: 0, entities: 1, features: 2, widgets: 3, pages: 4, app: 5, routes: 6 };
/** @type {Record<string, keyof typeof LAYER_RANK>} folder name -> layer */
const DIR_TO_LAYER = {
  shared: "shared",
  entities: "entities",
  features: "features",
  widgets: "widgets",
  _pages: "pages",
  app: "app",
  pages: "routes",
};
/** @type {Record<string, string>} alias -> folder under src */
const ALIASES = {
  "@shared": "shared",
  "@entities": "entities",
  "@features": "features",
  "@widgets": "widgets",
  "@pages": "_pages",
  "@app": "app",
};
const SLICED = new Set(["entities", "features", "widgets", "pages"]);

/**
 * @typedef {{ layer: keyof typeof LAYER_RANK, slice: string | null, unit: string, rest: string[] }} Loc
 */

/** @param {string} abs @returns {Loc | null} */
function locate(abs) {
  const rel = path.relative(SRC, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  const parts = rel.split(path.sep);
  const dir = parts[0] ?? "";
  const layer = DIR_TO_LAYER[dir];
  if (!layer) return null;
  if (layer === "routes") return { layer, slice: null, unit: "routes", rest: parts.slice(1) };
  if (layer === "app")
    return { layer, slice: null, unit: `app/${parts[1] ?? ""}`, rest: parts.slice(2) };
  if (layer === "shared") {
    if (parts[1] === "lib") {
      return { layer, slice: null, unit: `shared/lib/${parts[2] ?? ""}`, rest: parts.slice(3) };
    }
    return { layer, slice: null, unit: `shared/${parts[1] ?? ""}`, rest: parts.slice(2) };
  }
  const slice = parts[1] ?? "";
  return { layer, slice, unit: `${dir}/${slice}`, rest: parts.slice(2) };
}

/** True when `rest` (path inside a unit) points at its public API. */
function isPublicEntry(/** @type {string[]} */ rest) {
  if (rest.length === 0) return true;
  return rest.length === 1 && /^index(\.(ts|js|mjs))?$/.test(rest[0] ?? "");
}

/** @x cross-import API: entities/A/@x/B is public for code inside entities/B. */
function isCrossApiFor(/** @type {string[]} */ rest, /** @type {string | null} */ importerSlice) {
  return (
    rest.length === 2 && rest[0] === "@x" && rest[1]?.replace(/\.(ts|js)$/, "") === importerSlice
  );
}

/**
 * @param {string} spec
 * @param {string} filename
 * @returns {{ kind: "relative" | "alias", target: Loc | null } | null}
 */
function resolve(spec, filename) {
  const clean = spec.split("?")[0] ?? spec;
  if (clean.startsWith(".")) {
    return { kind: "relative", target: locate(path.resolve(path.dirname(filename), clean)) };
  }
  const match = /^(@[a-z]+)(?:\/(.*))?$/.exec(clean);
  const folder = match?.[1] ? ALIASES[match[1]] : undefined;
  if (!match || !folder) return null; // package or virtual module (e.g. astro:assets)
  return { kind: "alias", target: locate(path.join(SRC, folder, match[2] ?? "")) };
}

/**
 * @typedef {{ node: ESTree.Node, spec: string, from: Loc, kind: "relative" | "alias", to: Loc | null }} ImportInfo
 */

/**
 * Build a rule that runs `check` for every static import/re-export and string-literal dynamic
 * import() in the file.
 * @param {(ctx: Context, info: ImportInfo) => void} check
 */
function makeRule(check) {
  return defineRule({
    create(context) {
      const filename = context.filename;
      const from = locate(filename);
      if (!from) return {};
      /** @param {ESTree.Node} node @param {ESTree.Expression | null} source */
      const visit = (node, source) => {
        if (source?.type !== "Literal" || typeof source.value !== "string") return;
        const resolved = resolve(source.value, filename);
        if (!resolved) return;
        check(context, {
          node,
          spec: source.value,
          from,
          kind: resolved.kind,
          to: resolved.target,
        });
      };
      return {
        ImportDeclaration(node) {
          visit(node, node.source);
        },
        ExportNamedDeclaration(node) {
          visit(node, node.source);
        },
        ExportAllDeclaration(node) {
          visit(node, node.source);
        },
        ImportExpression(node) {
          visit(node, node.source);
        },
      };
    },
  });
}

const layers = makeRule((ctx, { node, spec, from, to }) => {
  if (!to) return;
  if (LAYER_RANK[to.layer] > LAYER_RANK[from.layer]) {
    ctx.report({
      node,
      message: `FSD layers: "${from.layer}" must not import from higher layer "${to.layer}" ("${spec}"). Allowed: layers strictly below.`,
    });
  }
});

const noCrossSlice = makeRule((ctx, { node, spec, from, to }) => {
  if (!to || to.layer !== from.layer || !SLICED.has(from.layer)) return;
  if (to.slice === from.slice) return;
  if (from.layer === "entities" && isCrossApiFor(to.rest, from.slice)) return;
  ctx.report({
    node,
    message: `FSD slices: "${from.unit}" must not import from sibling slice "${to.unit}" on the same layer ("${spec}"). Move shared code down a layer or use entities' @x API.`,
  });
});

const publicApi = makeRule((ctx, { node, spec, from, to }) => {
  if (!to || to.unit === from.unit || to.layer === "routes") return;
  if (from.layer === "app" && to.layer === "app") return;
  if (isPublicEntry(to.rest)) return;
  if (from.layer === "entities" && to.layer === "entities" && isCrossApiFor(to.rest, from.slice)) {
    return;
  }
  ctx.report({
    node,
    message: `FSD public API: import "${to.unit}" through its index.ts, not "${spec}".`,
  });
});

const relativeInSlice = makeRule((ctx, { node, spec, from, kind, to }) => {
  const appInternal = from.layer === "app" && to?.layer === "app";
  if (kind === "relative" && to && to.unit !== from.unit && !appInternal) {
    ctx.report({
      node,
      message: `FSD aliases: relative import "${spec}" leaves "${from.unit}"; use the path alias for "${to.unit}" (e.g. @${to.layer}/...).`,
    });
  } else if (kind === "alias" && to && to.unit === from.unit) {
    ctx.report({
      node,
      message: `FSD aliases: "${from.unit}" imports itself via "${spec}"; use a relative import inside the slice (avoids circular imports through index.ts).`,
    });
  }
});

export default definePlugin({
  meta: { name: "fsd-imports" },
  rules: {
    layers,
    "no-cross-slice": noCrossSlice,
    "public-api": publicApi,
    "relative-in-slice": relativeInSlice,
  },
});
