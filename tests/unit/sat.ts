/**
 * Exact oriented-box separating-axis (SAT) penetration for M2-AC5: a print tile is a
 * zero-thickness rectangle (the plane it renders as); a vessel is its real body (four walls and
 * a floor, as merged in the scene graph), plus the lid plane and the cap box while they are
 * visible (the same thresholds the renderer uses).
 */
import type { SceneState, TileState, VesselState } from "../../src/_pages/home/model/evaluate";
import {
  CAP_SIZE,
  LID_Y,
  TILE_H,
  TILE_W,
  VESSEL_FLOOR,
  VESSEL_WALL,
  type Vec3,
} from "../../src/_pages/home/model/keyframes";

export interface Obb {
  c: Vec3;
  u: readonly [Vec3, Vec3, Vec3];
  e: Vec3;
}

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

/**
 * Penetration depth of two oriented boxes: the smallest overlap over the 15 SAT axes. Negative
 * (or zero) means separated (or touching).
 */
export function penetration(A: Obb, B: Obb): number {
  const d: Vec3 = [B.c[0] - A.c[0], B.c[1] - A.c[1], B.c[2] - A.c[2]];
  const axes: Vec3[] = [...A.u, ...B.u];
  for (const a of A.u) {
    for (const b of B.u) {
      const c = cross(a, b);
      const n = Math.hypot(...c);
      if (n > 1e-6) axes.push([c[0] / n, c[1] / n, c[2] / n]);
    }
  }
  let min = Infinity;
  for (const axis of axes) {
    const ra = A.u.reduce((sum, u, i) => sum + (A.e[i] ?? 0) * Math.abs(dot(u, axis)), 0);
    const rb = B.u.reduce((sum, u, i) => sum + (B.e[i] ?? 0) * Math.abs(dot(u, axis)), 0);
    const overlap = ra + rb - Math.abs(dot(d, axis));
    if (overlap < min) min = overlap;
    if (min < 0) return min;
  }
  return min;
}

/** Rotation (three.js Euler order YXZ) applied to a vector. */
function rotateYXZ([rx, ry, rz]: Vec3, [x, y, z]: Vec3): Vec3 {
  const x1 = x * Math.cos(rz) - y * Math.sin(rz);
  const y1 = x * Math.sin(rz) + y * Math.cos(rz);
  const y2 = y1 * Math.cos(rx) - z * Math.sin(rx);
  const z2 = y1 * Math.sin(rx) + z * Math.cos(rx);
  return [x1 * Math.cos(ry) + z2 * Math.sin(ry), y2, -x1 * Math.sin(ry) + z2 * Math.cos(ry)];
}

/** A tile as an exact plane (half-thickness 0); `inset` shrinks its edges (abutting quarters). */
export function tileObb(tile: TileState, inset = 1): Obb {
  return {
    c: tile.pos,
    u: [
      rotateYXZ(tile.rot, [1, 0, 0]),
      rotateYXZ(tile.rot, [0, 1, 0]),
      rotateYXZ(tile.rot, [0, 0, 1]),
    ],
    e: [(TILE_W / 2) * tile.scale * inset, (TILE_H / 2) * tile.scale * inset, 0],
  };
}

type Part = readonly [number, number, number, number, number, number, string];
const T = VESSEL_WALL;
const F = VESSEL_FLOOR;
const BODY: readonly Part[] = [
  [0, 0, 0.5 - T / 2, 1, 1, T, "wall z+"],
  [0, 0, -0.5 + T / 2, 1, 1, T, "wall z-"],
  [0.5 - T / 2, 0, 0, T, 1, 1, "wall x+"],
  [-0.5 + T / 2, 0, 0, T, 1, 1, "wall x-"],
  [0, -0.5 + F / 2, 0, 1, F, 1, "floor"],
];

/** The vessel's solid parts as oriented boxes in world space. */
export function vesselParts(v: VesselState): { name: string; obb: Obb }[] {
  const c = Math.cos(v.yaw);
  const s = Math.sin(v.yaw);
  const ux: Vec3 = [c, 0, -s];
  const uy: Vec3 = [0, 1, 0];
  const uz: Vec3 = [s, 0, c];
  const toWorld = (x: number, y: number, z: number): Vec3 => [
    v.pos[0] + ux[0] * x * v.scl[0] + uz[0] * z * v.scl[2],
    v.pos[1] + y * v.scl[1],
    v.pos[2] + ux[2] * x * v.scl[0] + uz[2] * z * v.scl[2],
  ];
  const parts = BODY.map(([x, y, z, w, h, d, name]) => ({
    name,
    obb: {
      c: toWorld(x, y, z),
      u: [ux, uy, uz] as const,
      e: [(w / 2) * v.scl[0], (h / 2) * v.scl[1], (d / 2) * v.scl[2]] as Vec3,
    },
  }));
  if (v.lidOpacity > 0.001) {
    parts.push({
      name: "lid",
      obb: { c: toWorld(0, LID_Y, 0), u: [ux, uy, uz], e: [v.scl[0] / 2, 0, v.scl[2] / 2] },
    });
  }
  if (v.capScale > 0.001) {
    parts.push({
      name: "cap",
      obb: {
        c: v.capPos,
        u: [
          [1, 0, 0],
          [0, 1, 0],
          [0, 0, 1],
        ],
        e: [
          (CAP_SIZE[0] / 2) * v.capScale,
          (CAP_SIZE[1] / 2) * v.capScale,
          (CAP_SIZE[2] / 2) * v.capScale,
        ],
      },
    });
  }
  return parts;
}

export interface Hit {
  p: number;
  what: string;
  depth: number;
}

/**
 * Every interpenetration deeper than `eps` in one scene state: tile vs vessel parts, and tile vs
 * tile (1 % edge inset, so quarters that abut edge to edge as one print pass).
 */
export function intersections(s: SceneState, eps: number): Hit[] {
  const hits: Hit[] = [];
  s.tiles.forEach((tile, i) => {
    if (tile.scale <= 0.001) return;
    const t = tileObb(tile);
    s.vessels.forEach((v, j) => {
      for (const part of vesselParts(v)) {
        const depth = penetration(t, part.obb);
        if (depth > eps) hits.push({ p: s.p, what: `tile ${i} × vessel ${j} ${part.name}`, depth });
      }
    });
  });
  for (let a = 0; a < s.tiles.length; a += 1) {
    for (let b = a + 1; b < s.tiles.length; b += 1) {
      const A = s.tiles[a];
      const B = s.tiles[b];
      if (!A || !B) continue;
      const depth = penetration(tileObb(A, 0.99), tileObb(B, 0.99));
      if (depth > eps) hits.push({ p: s.p, what: `tile ${a} × tile ${b}`, depth });
    }
  }
  return hits;
}
