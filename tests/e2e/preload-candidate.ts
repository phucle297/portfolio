/**
 * PF-56: the stills preload check must pass only when currentSrc is the exact
 * imagesrcset candidate the preload picked for this viewport, not merely any
 * candidate in the set.
 */

export interface ResourceTimingLike {
  name: string;
  initiatorType: string;
  startTime: number;
}

export interface SrcsetCandidate {
  url: string;
  width: number;
}

const absoluteUrl = (url: string, base: string): string => new URL(url, base).href;

/** Normalize a possibly-relative URL against a base (`document.baseURI`). */
export function normalizeAssetUrl(url: string, base: string): string {
  return url === "" ? "" : absoluteUrl(url, base);
}

/** Parse an `imagesrcset` / `srcset` attribute into absolute URLs plus optional `w` descriptors. */
export function parseSrcset(srcset: string, base: string): SrcsetCandidate[] {
  const out: SrcsetCandidate[] = [];
  for (const raw of srcset.split(",")) {
    const part = raw.trim();
    if (part === "") continue;
    const tokens = part.split(/\s+/u);
    const url = tokens[0] ?? "";
    if (url === "") continue;
    const descriptor = tokens[1] ?? "";
    const widthMatch = /^(\d+)w$/u.exec(descriptor);
    out.push({
      url: absoluteUrl(url, base),
      width: widthMatch ? Number(widthMatch[1]) : 0,
    });
  }
  return out;
}

export function srcsetUrls(srcset: string, base: string): string[] {
  return parseSrcset(srcset, base).map((c) => c.url);
}

/**
 * The URL the preload actually fetched. Prefer a resource-timing entry with
 * `initiatorType === "link"` whose name is a candidate (or the explicit href).
 * If no link entry is present, use the earliest candidate resource — the head
 * preload starts before the `<img>`. Last, an explicit href or a single
 * candidate. Never “any URL that equals currentSrc”.
 */
export function preloadPickedCandidate(opts: {
  href: string;
  candidateUrls: readonly string[];
  resources: readonly ResourceTimingLike[];
}): string {
  const { href, candidateUrls, resources } = opts;
  const names = new Set(candidateUrls);
  if (href !== "") names.add(href);

  const earliest = (want: (entry: ResourceTimingLike) => boolean): string => {
    const hits = resources
      .filter(want)
      .toSorted((a, b) => a.startTime - b.startTime || a.name.localeCompare(b.name));
    return hits[0]?.name ?? "";
  };

  const isCandidate = (entry: ResourceTimingLike): boolean => names.has(entry.name);
  const fromLink = earliest((entry) => entry.initiatorType === "link" && isCandidate(entry));
  if (fromLink !== "") return fromLink;
  const fromAny = earliest(isCandidate);
  if (fromAny !== "") return fromAny;
  if (href !== "") return href;
  return candidateUrls.length === 1 ? (candidateUrls[0] ?? "") : "";
}

/**
 * Deterministic srcset pick for `sizes="100vw"` (same rule as the HTML
 * source-set selection: lowest density ≥ DPR, else the highest density).
 * Used only when resource timing did not record a fetch.
 */
export function computeSrcsetPick(opts: {
  candidates: readonly SrcsetCandidate[];
  viewportWidth: number;
  dpr: number;
}): string {
  const { candidates, viewportWidth, dpr } = opts;
  if (candidates.length === 0 || viewportWidth <= 0) return "";
  const withDensity = candidates
    .filter((c) => c.width > 0)
    .map((c) => ({ url: c.url, density: c.width / viewportWidth }));
  if (withDensity.length === 0) return candidates[0]?.url ?? "";
  const eligible = withDensity.filter((c) => c.density >= dpr);
  const pool = eligible.length > 0 ? eligible : withDensity;
  const chosen = pool.reduce((best, c) => {
    const preferLower = eligible.length > 0;
    if (preferLower) return c.density < best.density ? c : best;
    return c.density > best.density ? c : best;
  });
  return chosen.url;
}

/**
 * Passes only when `currentSrc` is the same candidate the preload picked.
 * Throws on a mismatch or a missing value so a planted mismatch fails the check.
 */
export function assertExactPreloadCandidate(currentSrc: string, preloadPicked: string): void {
  if (currentSrc === "" || preloadPicked === "") {
    throw new Error(
      `preload candidate missing (currentSrc=${JSON.stringify(currentSrc)}, preloadPicked=${JSON.stringify(preloadPicked)})`,
    );
  }
  if (currentSrc !== preloadPicked) {
    throw new Error(
      `shown still ${currentSrc} is not the preload-picked candidate ${preloadPicked}`,
    );
  }
}
