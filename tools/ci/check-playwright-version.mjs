#!/usr/bin/env node
// @ts-check
/**
 * PF-71: fail if the Playwright version CI uses (PLAYWRIGHT_VERSION and
 * mcr.microsoft.com/playwright:vX image tags in .github/workflows/*.yml)
 * differs from the resolved @playwright/test / playwright / playwright-core
 * versions in bun.lock. The message names both versions.
 *
 * Usage: node tools/ci/check-playwright-version.mjs [repo-root]
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const LOCKFILE_PACKAGES = Object.freeze(["@playwright/test", "playwright", "playwright-core"]);

/**
 * Drop YAML comments so a tag only in a comment is not treated as a pin.
 * @param {string} src
 * @returns {string}
 */
export const stripYamlComments = (src) =>
  src
    .split("\n")
    .map((line) => {
      const trimmed = line.trimStart();
      if (trimmed.startsWith("#")) return "";
      let out = "";
      /** @type {'"' | "'" | null} */
      let quote = null;
      for (let i = 0; i < line.length; i += 1) {
        const ch = line[i];
        if (quote) {
          out += ch;
          if (ch === quote && line[i - 1] !== "\\") quote = null;
          continue;
        }
        if (ch === '"' || ch === "'") {
          quote = ch;
          out += ch;
          continue;
        }
        if (ch === "#" && (i === 0 || /\s/.test(line[i - 1] ?? ""))) break;
        out += ch;
      }
      return out;
    })
    .join("\n");

/**
 * Resolved versions from bun.lock's packages table
 * (`"name": ["name@1.2.3", ...]`), not workspace ranges or peer ranges.
 * @param {string} lockText
 * @returns {Record<string, string>}
 */
export const lockfilePackageVersions = (lockText) => {
  /** @type {Record<string, string>} */
  const versions = {};
  for (const name of LOCKFILE_PACKAGES) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`"${escaped}":\\s*\\[\\s*"${escaped}@([^"]+)"`);
    const match = re.exec(lockText);
    const resolved = match?.[1];
    if (!match || !resolved) {
      throw new Error(`bun.lock has no resolved ${name} package entry`);
    }
    versions[name] = resolved;
  }
  return versions;
};

/**
 * Canonical lockfile Playwright version. Throws if the three packages disagree
 * or a resolved entry is missing.
 * @param {string} lockText
 * @returns {string}
 */
export const lockfilePlaywrightVersion = (lockText) => {
  const versions = lockfilePackageVersions(lockText);
  const unique = [...new Set(Object.values(versions))];
  const version = unique[0];
  if (unique.length !== 1 || !version) {
    const detail = LOCKFILE_PACKAGES.map((n) => `${n}=${versions[n]}`).join(", ");
    throw new Error(
      `bun.lock Playwright packages disagree (${detail}); they must share one version`,
    );
  }
  return version;
};

/**
 * @typedef {{ file: string, kind: "PLAYWRIGHT_VERSION" | "image", version: string, raw: string }} CiPin
 */

/**
 * @param {string} file
 * @param {string} yamlText
 * @returns {CiPin[]}
 */
export const ciPinsInYaml = (file, yamlText) => {
  const src = stripYamlComments(yamlText);
  /** @type {CiPin[]} */
  const pins = [];
  const envRe = /PLAYWRIGHT_VERSION:\s*["']?(\d+\.\d+\.\d+)["']?/g;
  for (const match of src.matchAll(envRe)) {
    const version = match[1];
    if (!version) continue;
    pins.push({
      file,
      kind: "PLAYWRIGHT_VERSION",
      version,
      raw: match[0].trim(),
    });
  }
  // Tag is v<major.minor.patch> plus an optional distro suffix (e.g. -noble).
  // Do not treat "-noble" as a semver pre-release; compare only x.y.z to bun.lock.
  const imageRe = /mcr\.microsoft\.com\/playwright:v(\d+\.\d+\.\d+)[^\s"']*/g;
  for (const match of src.matchAll(imageRe)) {
    const version = match[1];
    if (!version) continue;
    pins.push({
      file,
      kind: "image",
      version,
      raw: match[0],
    });
  }
  return pins;
};

/**
 * @param {string} lockVersion
 * @param {CiPin[]} pins
 * @returns {string[]}
 */
export const driftMessages = (lockVersion, pins) => {
  if (pins.length === 0) {
    return [
      `Playwright version drift: bun.lock has ${lockVersion} but no PLAYWRIGHT_VERSION env or mcr.microsoft.com/playwright:vX image tag was found in .github/workflows/*.yml`,
    ];
  }
  return pins
    .filter((pin) => pin.version !== lockVersion)
    .map((pin) => {
      if (pin.kind === "PLAYWRIGHT_VERSION") {
        return `Playwright version drift: bun.lock has ${lockVersion} but ${pin.file} PLAYWRIGHT_VERSION is ${pin.version}`;
      }
      return `Playwright version drift: bun.lock has ${lockVersion} but ${pin.file} image ${pin.raw} is ${pin.version}`;
    });
};

/**
 * @param {string} root
 * @returns {{ ok: true, version: string, pinCount: number } | { ok: false, message: string }}
 */
export const checkPlaywrightVersion = (root) => {
  const lockPath = join(root, "bun.lock");
  /** @type {string} */
  let lockVersion;
  try {
    lockVersion = lockfilePlaywrightVersion(readFileSync(lockPath, "utf8"));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, message };
  }

  const workflowsDir = join(root, ".github/workflows");
  /** @type {CiPin[]} */
  const pins = [];
  for (const name of readdirSync(workflowsDir).toSorted((a, b) => a.localeCompare(b))) {
    if (!name.endsWith(".yml") && !name.endsWith(".yaml")) continue;
    const file = `.github/workflows/${name}`;
    pins.push(...ciPinsInYaml(file, readFileSync(join(root, file), "utf8")));
  }

  const drifts = driftMessages(lockVersion, pins);
  if (drifts.length > 0) {
    return { ok: false, message: drifts.join("\n") };
  }
  return { ok: true, version: lockVersion, pinCount: pins.length };
};

const argvPath = process.argv[1];
const isMain = argvPath !== undefined && import.meta.url === pathToFileURL(argvPath).href;

if (isMain) {
  const root = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), "../..");
  const result = checkPlaywrightVersion(root);
  if (!result.ok) {
    console.error(`::error::${result.message.replaceAll("\n", "%0A")}`);
    console.error(result.message);
    process.exit(1);
  }
  console.error(`Playwright ${result.version} matches bun.lock and ${result.pinCount} CI pin(s).`);
}
