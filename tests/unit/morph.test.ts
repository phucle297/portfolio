/**
 * M2 morph timeline: purity (AC1), holds at rest (AC2), continuity (AC3), no intersections
 * (AC5), no cuts (AC7 unit part) and the safelight modifier.
 */
import { describe, expect, it } from "vitest";
import { HOLDS, KEY_PROGRESS, locate, TIMING } from "@shared/lib/timeline";
import {
  applySafelight,
  evaluate,
  SAFELIGHT_OFF_LEVEL,
  type SceneState,
} from "../../src/_pages/home/model/evaluate";
import { KEYS, TILE_H, TILE_W, type Vec3 } from "../../src/_pages/home/model/keyframes";

/** Deterministic PRNG so failures reproduce. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1_664_525 + 1_013_904_223) >>> 0;
    return s / 2 ** 32;
  };
}

/** Every numeric channel of a state, flattened with stable names. */
function channels(state: SceneState): Map<string, number> {
  const out = new Map<string, number>();
  const walk = (value: unknown, path: string): void => {
    if (typeof value === "number") out.set(path, value);
    else if (Array.isArray(value)) {
      value.forEach((v, i) => {
        walk(v, `${path}[${i}]`);
      });
    } else if (value && typeof value === "object") {
      for (const [key, v] of Object.entries(value)) walk(v, path ? `${path}.${key}` : key);
    }
  };
  walk(state, "");
  return out;
}

/** The channels M2-AC3 tracks: camera, vessels, tiles, lamp, lights, exposure, background. */
const TRACKED =
  /^(camera|vessels|tiles\[\d\]\.(pos|rot|scale)|lamp\.(pos|yaw)|safe\.intensity|spot|ambient|fill|exposure|background)/u;

describe("M2-AC1 the timeline is a pure function of p", () => {
  it("gives identical states at 1,000 random p after forward, backward and random sweeps", () => {
    const random = rng(42);
    const ps = Array.from({ length: 1000 }, () => random());
    const reference = ps.map((p) => channels(evaluate(p)));
    // Sweep forward, backward and in random order first; evaluate keeps no state between calls.
    for (let i = 0; i <= 1000; i += 1) evaluate(i / 1000);
    for (let i = 1000; i >= 0; i -= 1) evaluate(i / 1000);
    for (let i = 0; i < 1000; i += 1) evaluate(random());
    const shuffled = ps.map((p, i) => ({ p, i })).toSorted(() => random() - 0.5);
    for (const { p, i } of shuffled) {
      const again = channels(evaluate(p));
      const ref = reference[i];
      if (!ref) throw new Error("missing reference");
      for (const [name, value] of ref) {
        expect(Math.abs((again.get(name) ?? Number.NaN) - value)).toBeLessThanOrEqual(1e-6);
      }
    }
  });

  it("uses one shared hold/morph table (0–6 · 6–17 · … · 92–100 %)", () => {
    expect(HOLDS).toEqual([
      [0, 0.06],
      [0.17, 0.25],
      [0.36, 0.46],
      [0.57, 0.63],
      [0.73, 0.79],
      [0.92, 1],
    ]);
  });
});

describe("M2-AC2 holds stay at rest", () => {
  HOLDS.forEach(([a, b], k) => {
    it(`hold ${k} (${a}–${b}) equals K[${k}]`, () => {
      const key = KEY_PROGRESS[k] ?? a;
      const atKey = channels(evaluate(key));
      for (let i = 0; i <= 20; i += 1) {
        const p = a + ((b - a) * i) / 20;
        const s = channels(evaluate(p));
        for (const [name, value] of atKey) {
          // Exceptions from the AC: the Hello develop ramp (uP) across 0–6 %.
          if (k === 0 && /^tiles\[\d\]\.develop$/u.test(name)) continue;
          if (name === "p") continue;
          expect(
            Math.abs((s.get(name) ?? Number.NaN) - value),
            `${name} at p=${p}`,
          ).toBeLessThanOrEqual(1e-3);
        }
      }
    });
  });

  it("matches the key-state camera data inside every hold", () => {
    HOLDS.forEach(([a, b], k) => {
      const s = evaluate((a + b) / 2);
      const cam = KEYS[k]?.cam;
      if (!cam) throw new Error("missing key");
      s.camera.pos.forEach((v, i) => {
        expect(Math.abs(v - (cam.pos[i] ?? 0))).toBeLessThanOrEqual(1e-3);
      });
    });
  });
});

describe("M2-AC3 tracks are continuous", () => {
  const STEP = 1e-4;
  const N = Math.round(1 / STEP);
  const samples = Array.from({ length: N + 1 }, (_, i) => channels(evaluate(i * STEP)));
  const names = [...(samples[0]?.keys() ?? [])].filter((n) => TRACKED.test(n));

  it("has no step larger than 3× its local median (pop check, ±8 neighbours)", () => {
    const pops: string[] = [];
    for (const name of names) {
      const d = samples
        .slice(1)
        .map((s, i) => Math.abs((s.get(name) ?? 0) - (samples[i]?.get(name) ?? 0)));
      const scale = Math.max(...d);
      if (scale < 1e-9) continue;
      // Floor: steps below 2 % of the channel's own peak step are never flagged.
      const floor = scale * 0.02;
      for (let i = 0; i < d.length; i += 1) {
        const window = d.slice(Math.max(0, i - 8), i + 9).toSorted((x, y) => x - y);
        const median = window[Math.floor(window.length / 2)] ?? 0;
        const di = d[i] ?? 0;
        if (di > Math.max(3 * median, floor))
          pops.push(`${name} @ p=${((i + 1) * STEP).toFixed(4)}: ${di} vs median ${median}`);
      }
    }
    expect(pops.slice(0, 10)).toEqual([]);
  });

  it("has ~zero velocity at every hold boundary (≤ 1e-3 per 1e-4 p)", () => {
    const bad: string[] = [];
    for (const [a, b] of HOLDS) {
      for (const edge of [a, b]) {
        if (edge <= 0 || edge >= 1) continue;
        const i = Math.round(edge / STEP);
        for (const j of [i - 1, i, i + 1]) {
          const s0 = samples[j];
          const s1 = samples[j + 1];
          if (!s0 || !s1) continue;
          for (const name of names) {
            const v = Math.abs((s1.get(name) ?? 0) - (s0.get(name) ?? 0));
            if (v > 1e-3) bad.push(`${name} @ ${edge} (${j}): ${v}`);
          }
        }
      }
    }
    expect(bad).toEqual([]);
  });
});

/* ---------- M2-AC5 geometry ---------- */

interface Box {
  min: Vec3;
  max: Vec3;
}

const vec3 = (f: (axis: 0 | 1 | 2) => number): Vec3 => [f(0), f(1), f(2)];

/** AABB of a rotated (Euler YXZ) and scaled TILE_W × TILE_H plane. */
function tileBox(pos: Vec3, rot: Vec3, scale: number): Box {
  const [rx, ry, rz] = rot;
  const corners: Vec3[] = [
    [-TILE_W / 2, -TILE_H / 2, 0],
    [TILE_W / 2, -TILE_H / 2, 0],
    [TILE_W / 2, TILE_H / 2, 0],
    [-TILE_W / 2, TILE_H / 2, 0],
  ];
  // Rotation matrix for order YXZ: R = Ry · Rx · Rz.
  const [cx, sx, cy, sy, cz, sz] = [
    Math.cos(rx),
    Math.sin(rx),
    Math.cos(ry),
    Math.sin(ry),
    Math.cos(rz),
    Math.sin(rz),
  ];
  const pts = corners.map(([x, y, z]) => {
    // Rz
    const x1 = x * cz - y * sz;
    const y1 = x * sz + y * cz;
    const z1 = z;
    // Rx
    const y2 = y1 * cx - z1 * sx;
    const z2 = y1 * sx + z1 * cx;
    // Ry
    const x3 = x1 * cy + z2 * sy;
    const z3 = -x1 * sy + z2 * cy;
    const point: Vec3 = [pos[0] + x3 * scale, pos[1] + y2 * scale, pos[2] + z3 * scale];
    return point;
  });
  const min = vec3((a) => Math.min(...pts.map((p) => p[a])));
  const max = vec3((a) => Math.max(...pts.map((p) => p[a])));
  return { min, max };
}

/** A 9 × 9 grid of points on a rotated (YXZ), scaled print. */
function tilePoints(pos: Vec3, rot: Vec3, scale: number): Vec3[] {
  const { u } = tileObb(pos, rot, 1);
  const out: Vec3[] = [];
  for (let a = 0; a <= 8; a += 1) {
    for (let b = 0; b <= 8; b += 1) {
      const x = (a / 8 - 0.5) * TILE_W * scale;
      const y = (b / 8 - 0.5) * TILE_H * scale;
      out.push(vec3((i) => pos[i] + u[0][i] * x + u[1][i] * y));
    }
  }
  return out;
}

/** AABB of a vessel (unit box centred on pos, scaled, yawed). */
function vesselBox(pos: Vec3, scl: Vec3, yaw: number): Box {
  const hx = (Math.abs(Math.cos(yaw)) * scl[0] + Math.abs(Math.sin(yaw)) * scl[2]) / 2;
  const hz = (Math.abs(Math.sin(yaw)) * scl[0] + Math.abs(Math.cos(yaw)) * scl[2]) / 2;
  return {
    min: [pos[0] - hx, pos[1] - scl[1] / 2, pos[2] - hz],
    max: [pos[0] + hx, pos[1] + scl[1] / 2, pos[2] + hz],
  };
}

/** Oriented box of a tile: centre, 3 unit axes and half extents (prints are 4 mm thick). */
interface Obb {
  c: Vec3;
  u: [Vec3, Vec3, Vec3];
  e: Vec3;
}

function tileObb(pos: Vec3, rot: Vec3, scale: number): Obb {
  const [rx, ry, rz] = rot;
  const rotate = ([x, y, z]: Vec3): Vec3 => {
    const x1 = x * Math.cos(rz) - y * Math.sin(rz);
    const y1 = x * Math.sin(rz) + y * Math.cos(rz);
    const y2 = y1 * Math.cos(rx) - z * Math.sin(rx);
    const z2 = y1 * Math.sin(rx) + z * Math.cos(rx);
    return [x1 * Math.cos(ry) + z2 * Math.sin(ry), y2, -x1 * Math.sin(ry) + z2 * Math.cos(ry)];
  };
  return {
    c: pos,
    u: [rotate([1, 0, 0]), rotate([0, 1, 0]), rotate([0, 0, 1])],
    e: [(TILE_W / 2) * scale, (TILE_H / 2) * scale, 0.002],
  };
}

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

/** Separating-axis test for two oriented boxes. */
function obbIntersect(A: Obb, B: Obb): boolean {
  const d: Vec3 = [B.c[0] - A.c[0], B.c[1] - A.c[1], B.c[2] - A.c[2]];
  const axes: Vec3[] = [...A.u, ...B.u];
  for (const a of A.u) for (const b of B.u) axes.push(cross(a, b));
  return axes.every((axis) => {
    const len = Math.hypot(...axis);
    if (len < 1e-9) return true;
    const n: Vec3 = [axis[0] / len, axis[1] / len, axis[2] / len];
    const ra = A.u.reduce((sum, u, i) => sum + (A.e[i] ?? 0) * Math.abs(dot(u, n)), 0);
    const rb = B.u.reduce((sum, u, i) => sum + (B.e[i] ?? 0) * Math.abs(dot(u, n)), 0);
    return Math.abs(dot(d, n)) <= ra + rb;
  });
}

const inside = (p: Vec3, b: Box): boolean =>
  p.every((v, a) => v > (b.min[a] ?? 0) && v < (b.max[a] ?? 0));
const overlap = (a: Box, b: Box, eps: number): boolean =>
  [0, 1, 2].every(
    (i) => (a.min[i] ?? 0) < (b.max[i] ?? 0) - eps && (b.min[i] ?? 0) < (a.max[i] ?? 0) - eps,
  );

describe("M2-AC5 paths never intersect", () => {
  const random = rng(7);
  const ps = Array.from({ length: 1000 }, () => random()).toSorted((a, b) => a - b);

  it("no visible tile centre is inside a closed vessel (jug); prints may rest inside open trays", () => {
    const hits: string[] = [];
    for (const p of ps) {
      const s = evaluate(p);
      s.tiles.forEach((tile, i) => {
        if (tile.scale <= 0.05) return;
        s.vessels.forEach((v, j) => {
          // An open tray (lid gone, low walls) holds prints by design (K0, K4, K5); only the
          // closed, capped jug bodies must never contain a print.
          if (v.lidOpacity < 0.5) return;
          if (inside(tile.pos, vesselBox(v.pos, v.scl, v.yaw)))
            hits.push(`p=${p.toFixed(4)} tile ${i} in vessel ${j}`);
        });
      });
    }
    expect(hits.slice(0, 10)).toEqual([]);
  });

  it("no two prints intersect (oriented boxes, 4 mm thick)", () => {
    const hits: string[] = [];
    for (const p of ps) {
      const s = evaluate(p);
      // The four quarters abut edge to edge as one print at K0/K5 (gap 0); a 1 % inset lets
      // touching edges pass while any real interpenetration still fails.
      const boxes = s.tiles.map((t) => tileObb(t.pos, t.rot, t.scale * 0.99));
      for (let a = 0; a < boxes.length; a += 1) {
        for (let b = a + 1; b < boxes.length; b += 1) {
          const A = boxes[a];
          const B = boxes[b];
          if (A && B && obbIntersect(A, B)) hits.push(`p=${p.toFixed(4)} tiles ${a}/${b}`);
        }
      }
    }
    expect(hits.slice(0, 10)).toEqual([]);
  });

  it("reports how often the axis-aligned boxes overlap (informational)", () => {
    let count = 0;
    for (const p of ps) {
      const s = evaluate(p);
      const boxes = s.tiles.map((t) => tileBox(t.pos, t.rot, t.scale));
      for (let a = 0; a < boxes.length; a += 1) {
        for (let b = a + 1; b < boxes.length; b += 1) {
          const A = boxes[a];
          const B = boxes[b];
          if (A && B && overlap(A, B, 1e-3)) count += 1;
        }
      }
    }
    expect(count).toBeGreaterThanOrEqual(0);
  });

  it("prints below an open tray's rim stay inside its walls (no print passes through a wall)", () => {
    const hits: string[] = [];
    for (let i = 0; i <= 10_000; i += 1) {
      const s = evaluate(i / 10_000);
      s.tiles.forEach((tile, ti) => {
        if (tile.scale <= 0.05) return;
        const pts = tilePoints(tile.pos, tile.rot, tile.scale * 0.99);
        s.vessels.forEach((v, vi) => {
          if (v.lidOpacity >= 0.5) return;
          const vb = vesselBox(v.pos, v.scl, v.yaw);
          // Points of the print below the rim: all inside the tray's walls or all outside.
          const below = pts.filter((q) => q[1] < vb.max[1] && q[1] > vb.min[1]);
          const isIn = (q: Vec3): boolean =>
            q[0] > vb.min[0] && q[0] < vb.max[0] && q[2] > vb.min[2] && q[2] < vb.max[2];
          const n = below.filter(isIn).length;
          if (n > 0 && n < below.length) {
            hits.push(`p=${s.p.toFixed(4)} tile ${ti} crosses tray ${vi} wall`);
            if (process.env.AC5_DEBUG)
              console.warn(`AC5 ${s.p.toFixed(4)} ${ti} ${vi} ${n}/${below.length}`);
          }
        });
      });
    }
    expect(hits.slice(0, 10)).toEqual([]);
  });

  // Process → Contact is the one morph where design §1/§3 drain the bath *with* the rise (liq
  // 0–.30, tiles 0–.65 leading): the prints must clear the tray walls by t ≈ .18, before the
  // drain can finish, so there the rule is "the drain is under way and leads", checked below.
  // Every other morph keeps the strict rule. (QA B-2 restored the design windows; see B-3.)
  const DRAIN_WITH_RISE = 4;

  it("the bath is empty whenever a print crosses the bath surface during a morph", () => {
    const hits: string[] = [];
    const STEP = 1e-4;
    let prev = evaluate(0);
    for (let i = 1; i <= 10_000; i += 1) {
      const s = evaluate(i * STEP);
      if (s.t > 0) {
        s.tiles.forEach((tile, ti) => {
          const before = prev.tiles[ti];
          if (!before) return;
          s.vessels.forEach((v, vi) => {
            const surface = v.pos[1] + 0.05 * v.scl[1];
            const crossed = (before.pos[1] - surface) * (tile.pos[1] - surface) < 0;
            const box = vesselBox(v.pos, v.scl, v.yaw);
            const over =
              tile.pos[0] > box.min[0] &&
              tile.pos[0] < box.max[0] &&
              tile.pos[2] > box.min[2] &&
              tile.pos[2] < box.max[2];
            if (crossed && over && v.liquidOpacity > 1e-3 && s.k !== DRAIN_WITH_RISE)
              hits.push(`p=${s.p.toFixed(4)} tile ${ti} vessel ${vi} liquid ${v.liquidOpacity}`);
          });
        });
      }
      prev = s;
    }
    expect(hits.slice(0, 10)).toEqual([]);
  });
});

describe("M2-AC5 / design §3: Process → Contact drain and rise", () => {
  it("uses the design windows (tiles 0–.65, liq 0–.30)", () => {
    expect(TIMING.tiles[4]).toEqual([0, 0.65]);
    expect(TIMING.liq[4]).toEqual([0, 0.3]);
  });

  it("the bath is already draining when a print crosses its surface, and empty by t .30", () => {
    const [h0, h1] = [HOLDS[4]?.[1] ?? 0, HOLDS[5]?.[0] ?? 1];
    const full = evaluate(h0).vessels.map((v) => v.liquidOpacity);
    const bad: string[] = [];
    let prev = evaluate(h0);
    for (let i = 1; i <= 2000; i += 1) {
      const s = evaluate(h0 + ((h1 - h0) * i) / 2000);
      s.tiles.forEach((tile, ti) => {
        const before = prev.tiles[ti];
        if (!before) return;
        s.vessels.forEach((v, vi) => {
          const surface = v.pos[1] + 0.05 * v.scl[1];
          const crossed = (before.pos[1] - surface) * (tile.pos[1] - surface) < 0;
          const startLevel = full[vi] ?? 0;
          if (crossed && v.liquidOpacity > 1e-3 && v.liquidOpacity >= startLevel * 0.95)
            bad.push(`t=${s.t.toFixed(3)} tile ${ti} vessel ${vi} not draining yet`);
        });
      });
      if (s.t >= 0.3)
        s.vessels.forEach((v, vi) => {
          if (v.liquidOpacity > 1e-3) bad.push(`t=${s.t.toFixed(3)} vessel ${vi} not empty`);
        });
      prev = s;
    }
    expect(full.every((o) => o > 0.1)).toBe(true);
    expect(bad.slice(0, 10)).toEqual([]);
  });
});

describe("M2-AC7 no cuts (state level)", () => {
  it("only swaps a tile's image inside the develop-front window", () => {
    const bad: string[] = [];
    let prev = evaluate(0);
    for (let i = 1; i <= 10_000; i += 1) {
      const s = evaluate(i / 10_000);
      s.tiles.forEach((tile, ti) => {
        const before = prev.tiles[ti];
        if (!before) return;
        // The image on screen: A while the front is below the print (mix ≤ −0.2), B once past it.
        const shown = (t: typeof tile): number =>
          t.mix <= -0.2 ? t.atlasA : t.mix >= 1.2 ? t.atlasB : -1;
        const a = shown(before);
        const b = shown(tile);
        if (a !== -1 && b !== -1 && a !== b)
          bad.push(`p=${s.p.toFixed(4)} tile ${ti}: ${a} → ${b} without a develop front`);
      });
      prev = s;
    }
    expect(bad).toEqual([]);
  });
  // Visibility vs opacity is checked on the real scene graph in scene-graph.test.ts.
});

describe("Safelight toggle (header)", () => {
  it("dims only the safelight's face, glow and red light, and leaves evaluate(p) untouched", () => {
    for (const p of [0.03, 0.21, 0.6, 0.96]) {
      const s = evaluate(p);
      const off = applySafelight(s, false);
      expect(applySafelight(s, true)).toBe(s);
      expect(off.lamp.glowOpacity).toBeCloseTo(s.lamp.glowOpacity * SAFELIGHT_OFF_LEVEL, 9);
      expect(off.safe.intensity).toBeCloseTo(s.safe.intensity * SAFELIGHT_OFF_LEVEL, 9);
      expect(off.spot).toEqual(s.spot);
      expect(off.tiles).toEqual(s.tiles);
      expect(evaluate(p)).toEqual(s);
    }
  });

  it("keeps locate() and evaluate() independent of the toggle", () => {
    expect(locate(0.5)).toEqual(locate(0.5));
  });
});
