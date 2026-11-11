// @ts-check
/**
 * `prepare` hook: installs the Lefthook git hooks when it makes sense, and never fails the
 * install. Skips when there is no git repository (tarball/CI checkout without .git), when
 * LEFTHOOK=0, or when Lefthook is not installed (e.g. production-only install).
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const skip = (/** @type {string} */ reason) => {
  process.stdout.write(`[hooks] skipping lefthook install: ${reason}\n`);
  process.exit(0);
};

if (process.env.LEFTHOOK === "0" || process.env.LEFTHOOK === "false") skip("LEFTHOOK=0");

const git = spawnSync("git", ["rev-parse", "--git-dir"], { stdio: "ignore" });
if (git.error || git.status !== 0) skip("not inside a git repository");

const bin = join(process.cwd(), "node_modules", ".bin", "lefthook");
if (!existsSync(bin)) skip("lefthook is not installed");

const result = spawnSync(bin, ["install"], { stdio: "inherit" });
if (result.status !== 0) {
  console.warn("[hooks] 'lefthook install' failed; run `bunx lefthook install` manually.");
}
