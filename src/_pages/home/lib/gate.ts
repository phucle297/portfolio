/**
 * Cheap capability gates for the 3D island (build plan M1-AC14, design.md §10 "Loading").
 * All of them must pass before the WebGL probe runs, and the probe must pass before three.js is
 * requested. No three.js import here: this module ships in the initial bundle.
 */
import { motionAllowed } from "@shared/lib/motion";

/** Minimum viewport width for the full tier. */
export const MIN_FULL_TIER_WIDTH = 768;

interface NetworkInformationLike {
  saveData?: boolean;
}

export function saveDataOn(): boolean {
  const connection = (navigator as Navigator & { connection?: NetworkInformationLike }).connection;
  return connection?.saveData === true;
}

export interface GateResult {
  pass: boolean;
  /** First gate that failed, for diagnostics and tests. */
  reason?: "reduced-motion" | "pointer" | "width" | "save-data";
}

export function cheapGates(): GateResult {
  if (!motionAllowed()) return { pass: false, reason: "reduced-motion" };
  if (!window.matchMedia("(pointer: fine)").matches) return { pass: false, reason: "pointer" };
  if (window.innerWidth < MIN_FULL_TIER_WIDTH) return { pass: false, reason: "width" };
  if (saveDataOn()) return { pass: false, reason: "save-data" };
  return { pass: true };
}
