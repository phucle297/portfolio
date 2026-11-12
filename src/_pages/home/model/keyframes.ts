/**
 * Key states of the persistent darkroom scene, one per section (design.md §4). Pure data in
 * three.js world units (1 ≈ 10 cm), radians (Euler YXZ) and 0xRRGGBB colours.
 */

export type Vec3 = readonly [number, number, number];

export interface CameraKey {
  pos: Vec3;
  tgt: Vec3;
  fov: number;
}

export interface VesselKey {
  pos: Vec3;
  scl: Vec3;
  yaw: number;
  color: number;
  /** 1 = tray (lid hidden, no cap), 0 = jug (lid and cap on). */
  tray: number;
}

/** Index of the print atlas a tile shows. */
export type AtlasIndex = 0 | 1 | 2 | 3 | 4 | 5;

export interface TileKey {
  pos: Vec3;
  rot: Vec3;
  s: number;
  tex: AtlasIndex;
}

export interface LampKey {
  pos: Vec3;
  yaw: number;
  timer: number;
  white: number;
  glow: number;
}

export interface SpotKey {
  pos: Vec3;
  tgt: Vec3;
  int: number;
  ang: number;
  col: number;
}

export interface KeyState {
  cam: CameraKey;
  ves: readonly VesselKey[];
  tiles: readonly TileKey[];
  lamp: LampKey;
  spot: SpotKey;
  amb: { col: number; int: number };
  safe: number;
  fill: number;
  exp: number;
  bg: number;
  lit: number;
  /** Bath level (liquid opacity factor); defaults to 1. */
  liq?: number;
}

/** One print tile is a quarter of the 3.6 × 2.57 print. */
export const TILE_W = 1.8;
export const TILE_H = 1.2857;

/**
 * Tile i (TL, TR, BL, BR quadrant of the print) → left-to-right slot on the line, jug row and
 * tray row, so prints that leave the tray in column order never cross paths.
 */
export const SLOT = [0, 2, 1, 3] as const;

export const TILE_COUNT = 4;
export const VESSEL_COUNT = 4;

const PI = Math.PI;
const DARK = 0x2a_1a_12;
const AMBER = 0xc0_6a_26;
const AMBER_DEEP = 0xa0_50_1c;
const BG = 0x0e_0a_08;
const BG_LIT = 0x15_10_0c;
const SAFE_SPOT = 0xff_b0_70;
const SAFE_AMB = 0xff_9a_50;
const INDICES = [0, 1, 2, 3] as const;

const slotOf = (i: number): number => SLOT[i] ?? i;

const trayTile = (i: number, gap: number, yaw: number, tex: AtlasIndex): TileKey => {
  const col = i % 2;
  const row = i >> 1;
  const cx = (col - 0.5) * (TILE_W + gap);
  const cz = (row - 0.5) * (TILE_H + gap);
  return {
    pos: [cx * Math.cos(yaw) + cz * Math.sin(yaw), 0.075, -cx * Math.sin(yaw) + cz * Math.cos(yaw)],
    rot: [-PI / 2, yaw, 0],
    s: 1,
    tex,
  };
};

/** Vessels nested inside the big tray (vessels 1–3 hide inside vessel 0). */
const nested = (yaw: number): VesselKey[] =>
  INDICES.map((i) => ({
    pos: [0, 0.225, 0],
    scl: i === 0 ? [4.6, 0.45, 3.4] : [4.5 - i * 0.02, 0.44, 3.3 - i * 0.02],
    yaw,
    color: DARK,
    tray: 1,
  }));

export const KEYS: readonly KeyState[] = [
  {
    // 0 Hello: developer tray, the print develops.
    cam: { pos: [-2.7, 6.3, 6.8], tgt: [-1.25, 0.5, -0.5], fov: 34 },
    ves: nested(-0.12),
    tiles: INDICES.map((i) => trayTile(i, 0, -0.06, 0)),
    lamp: { pos: [4.6, 4.4, -3.6], yaw: -0.5, timer: 0, white: 0, glow: 1 },
    spot: { pos: [0, 7.5, 2.2], tgt: [0, 0, 0], int: 80, ang: 0.5, col: SAFE_SPOT },
    amb: { col: SAFE_AMB, int: 0.25 },
    safe: 60,
    fill: 0,
    exp: 1.1,
    bg: BG,
    lit: 0,
  },
  {
    // 1 Journey: the print splits into four contact-sheet frames.
    cam: { pos: [0.5, 5.5, 3.9], tgt: [-1.3, 0, 0.15], fov: 34 },
    ves: nested(0),
    tiles: INDICES.map((i) => trayTile(i, 0.16, 0, 1)),
    lamp: { pos: [4.6, 4.4, -3.6], yaw: -0.5, timer: 0, white: 0, glow: 1 },
    spot: { pos: [0, 7, 2], tgt: [0, 0, 0], int: 90, ang: 0.5, col: SAFE_SPOT },
    amb: { col: SAFE_AMB, int: 0.25 },
    safe: 55,
    fill: 0,
    exp: 1.1,
    bg: BG,
    lit: 0,
  },
  {
    // 2 Work: frames lift out of the tray and hang on the line as case prints.
    cam: { pos: [0.6, 2.7, 8.4], tgt: [0.4, 2.3, -1.6], fov: 34 },
    ves: nested(0),
    tiles: INDICES.map((i) => {
      const j = slotOf(i);
      return {
        pos: [-3.15 + j * 2.1, 2.42, -1.6],
        rot: [0, -0.1 * (j - 1.5), 0.02 * (j - 1.5)],
        s: 1,
        tex: 2,
      };
    }),
    lamp: { pos: [5.4, 4.6, -3.4], yaw: -0.5, timer: 0, white: 0, glow: 1 },
    spot: { pos: [0, 6, 6], tgt: [0, 2.3, -1.6], int: 120, ang: 0.6, col: SAFE_SPOT },
    amb: { col: SAFE_AMB, int: 0.3 },
    safe: 50,
    fill: 0,
    exp: 1.1,
    bg: BG,
    lit: 0,
    liq: 0,
  },
  {
    // 3 Services: the tray splits into four amber jugs, prints become labels, safelight = timer.
    cam: { pos: [1, 3.3, 10.8], tgt: [0.9, 2.1, 0], fov: 34 },
    ves: INDICES.map((i) => ({
      pos: [-2.4 + i * 1.6, 1.2, 0],
      scl: [1.15, 2.4, 1],
      yaw: 0,
      color: i % 2 === 1 ? AMBER_DEEP : AMBER,
      tray: 0,
    })),
    tiles: INDICES.map((i) => {
      const j = slotOf(i);
      return { pos: [-2.4 + j * 1.6, 1.15, 0.515], rot: [0, 0, 0], s: 0.56, tex: 3 };
    }),
    lamp: { pos: [4.05, 0.62, 0.7], yaw: -0.5, timer: 1, white: 0, glow: 0.55 },
    spot: { pos: [0, 7, 5], tgt: [0, 1, 0], int: 120, ang: 0.6, col: SAFE_SPOT },
    amb: { col: SAFE_AMB, int: 0.3 },
    safe: 30,
    fill: 0,
    exp: 1.1,
    bg: BG,
    lit: 0,
    liq: 0,
  },
  {
    // 4 Process: jugs lie down into four trays, labels flatten into step prints.
    cam: { pos: [0, 8.6, 12.9], tgt: [0, 1.9, 0], fov: 34 },
    ves: INDICES.map((i) => ({
      pos: [-4.65 + i * 3.1, 0.225, 0],
      scl: [2.8, 0.45, 2.1],
      yaw: 0,
      color: DARK,
      tray: 1,
    })),
    tiles: INDICES.map((i) => {
      const j = slotOf(i);
      return { pos: [-4.65 + j * 3.1, 0.075, 0], rot: [-PI / 2, 0, 0], s: 1.2, tex: 4 };
    }),
    lamp: { pos: [6.4, 4.6, -3.4], yaw: -0.6, timer: 0, white: 0, glow: 1 },
    spot: { pos: [-4.6, 7, 3], tgt: [-4.65, 0, 0], int: 140, ang: 0.35, col: SAFE_SPOT },
    amb: { col: SAFE_AMB, int: 0.28 },
    safe: 55,
    fill: 0.8,
    exp: 1.1,
    bg: BG,
    lit: 0,
  },
  {
    // 5 Contact: trays slide back into one, prints merge into one, lights on.
    cam: { pos: [-3, 7.5, 6.9], tgt: [-1.2, 0.6, -0.6], fov: 34 },
    ves: nested(-0.06),
    tiles: INDICES.map((i) => trayTile(i, 0, -0.06, 5)),
    lamp: { pos: [1.6, 5.6, -3], yaw: -0.2, timer: 0, white: 1, glow: 0.3 },
    spot: { pos: [2, 9, 4], tgt: [0, 0, 0], int: 150, ang: 0.65, col: 0xff_e6_c8 },
    amb: { col: 0xff_f0_dd, int: 0.55 },
    safe: 18,
    fill: 0,
    exp: 1.25,
    bg: BG_LIT,
    lit: 1,
    liq: 0,
  },
];
