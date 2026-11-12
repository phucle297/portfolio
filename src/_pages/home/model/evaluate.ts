/**
 * `evaluate(p)` is the whole scene as a pure function of scroll progress (design.md §3, §11.1).
 * It returns plain data (positions, rotations, scales, linear-sRGB colours, opacities, uniforms);
 * the three.js layer only copies it onto objects that were built once at init. Ported from the
 * round-7 prototype `scene.js` `set(p)`.
 */
import { clamp, locate, TIMING, windowed, type Track } from "@shared/lib/timeline";
import { KEYS, SLOT, type AtlasIndex, type KeyState, type Vec3 } from "./keyframes";

/** Linear-sRGB colour triple (three.js working colour space). */
export type Rgb = readonly [number, number, number];

export interface VesselState {
  pos: Vec3;
  scl: Vec3;
  yaw: number;
  color: Rgb;
  lidOpacity: number;
  liquidOpacity: number;
  capScale: number;
  capPos: Vec3;
}

export interface TileState {
  pos: Vec3;
  rot: Vec3;
  scale: number;
  atlasA: AtlasIndex;
  atlasB: AtlasIndex;
  /** Develop-front position for the atlas swap (`uMix`). */
  mix: number;
  /** Develop level (`uP`): 1 = blank paper, −0.3 = fully developed. */
  develop: number;
  /** Safelight → daylight tone (`uLit`). */
  lit: number;
}

export interface SceneState {
  p: number;
  k: number;
  t: number;
  camera: { pos: Vec3; target: Vec3; fov: number };
  vessels: readonly VesselState[];
  tiles: readonly TileState[];
  lamp: {
    pos: Vec3;
    yaw: number;
    timerOpacity: number;
    safeColor: Rgb;
    glowOpacity: number;
    glowPos: Vec3;
    cordLength: number;
    cordPos: Vec3;
  };
  safe: { pos: Vec3; intensity: number; color: Rgb };
  spot: { pos: Vec3; target: Vec3; intensity: number; angle: number; color: Rgb };
  ambient: { color: Rgb; intensity: number };
  fill: number;
  exposure: number;
  background: Rgb;
}

export interface EvaluateOptions {
  /** Portrait framing (lite tier on tall viewports): subject in the top half, copy below. */
  portrait?: boolean;
  /** Show the Hello print fully developed (used for stills). */
  developed?: boolean;
}

const PI = Math.PI;
const CEILING = 12;
const LAMP_HANG = 0.62;

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const lerp3 = (a: Vec3, b: Vec3, t: number): Vec3 => [
  lerp(a[0], b[0], t),
  lerp(a[1], b[1], t),
  lerp(a[2], b[2], t),
];

/** sRGB transfer function → linear (matches three.js `SRGBToLinear`). */
export const srgbToLinear = (c: number): number =>
  c < 0.04045 ? c * 0.077_399_380_8 : (c * 0.947_867_298_6 + 0.052_132_701_4) ** 2.4;

/** 0xRRGGBB (sRGB) → linear-sRGB triple, like `new THREE.Color(hex)`. */
export const hexToLinear = (hex: number): Rgb => [
  srgbToLinear(((hex >> 16) & 255) / 255),
  srgbToLinear(((hex >> 8) & 255) / 255),
  srgbToLinear((hex & 255) / 255),
];

/** Colour lerp in linear space (`THREE.Color.lerp`). */
const lerpColor = (a: number, b: number, t: number): Rgb => {
  const A = hexToLinear(a);
  const B = hexToLinear(b);
  return [lerp(A[0], B[0], t), lerp(A[1], B[1], t), lerp(A[2], B[2], t)];
};

const keyAt = (index: number): KeyState => {
  const key = KEYS[Math.min(KEYS.length - 1, Math.max(0, index))];
  if (!key) throw new Error(`Missing key state ${index}`);
  return key;
};

function pick<T>(list: readonly T[], index: number): T {
  const item = list[index];
  if (item === undefined) throw new Error(`Missing item ${index}`);
  return item;
}

export function evaluate(p: number, options: EvaluateOptions = {}): SceneState {
  const { k, t } = locate(p);
  const A = keyAt(k);
  const B = keyAt(k + 1);
  const tw = (track: Track): number => (t > 0 ? windowed(t, pick(TIMING[track], k)) : 0);

  // Camera: eased segment plus a crane arc on every morph.
  const tc = tw("cam");
  const camPos = [...lerp3(A.cam.pos, B.cam.pos, tc)] as [number, number, number];
  const camTgt = [...lerp3(A.cam.tgt, B.cam.tgt, tc)] as [number, number, number];
  camPos[1] += Math.sin(PI * tc) * 0.7;
  let fov = lerp(A.cam.fov, B.cam.fov, tc);
  if (options.portrait === true) {
    for (let i = 0; i < 3; i += 1) {
      const target = camTgt[i] ?? 0;
      camPos[i] = target + ((camPos[i] ?? 0) - target) * 1.55;
    }
    camTgt[0] += 1.5;
    camTgt[1] -= 3.6;
    fov = 50;
  }

  // Vessels (tray ⇄ jug).
  const tv = tw("ves");
  const level = lerp(A.liq ?? 1, B.liq ?? 1, tw("liq"));
  const vessels = A.ves.map((a, i): VesselState => {
    const b = pick(B.ves, i);
    const e = clamp(tv * 1.15 - i * 0.05);
    const pos = lerp3(a.pos, b.pos, e);
    const scl = lerp3(a.scl, b.scl, e);
    const tray = lerp(a.tray, b.tray, e);
    const capScale = 1 - tray;
    return {
      pos,
      scl,
      yaw: lerp(a.yaw, b.yaw, e),
      color: lerpColor(a.color, b.color, e),
      lidOpacity: 1 - tray,
      liquidOpacity: 0.2 * tray * level,
      capScale,
      capPos: [pos[0], pos[1] + scl[1] / 2 + 0.14 * capScale, pos[2]],
    };
  });

  // Tiles (the four quarters of the print).
  const tt = tw("tiles");
  const tx = tw("tex");
  const lit = lerp(A.lit, B.lit, tw("light"));
  const tiles = A.tiles.map((a, i): TileState => {
    const b = pick(B.tiles, i);
    const stagger = k === 1 ? (i >> 1) * 0.15 : pick(SLOT, i) * 0.05;
    const e = k === 3 ? tt : clamp(tt * 1.15 - stagger);
    const pos = [...lerp3(a.pos, b.pos, e)] as [number, number, number];
    // Arc heights and swings follow the prototype that rendered the mockups (its morph indices
    // sit one later than the prose in design.md §3; the mockups and smoothness run used these).
    const lift = k === 1 ? 0.5 + 0.25 * (i >> 1) : k === 2 ? 1.4 : k === 3 ? 1 : 0;
    pos[1] += Math.sin(PI * e) * lift;
    // Prints hover above the walls until the trays have merged. They leave only once the bath
    // has drained (liq window ends at .12) and hover on separate layers, so the outer prints
    // slide over the inner ones instead of through them (M2-AC5).
    if (k === 4) {
      const hover = 0.55 + 0.1 * pick(SLOT, i);
      pos[1] += hover * windowed(t, [0.12, 0.3]) * (1 - windowed(t, [0.6, 1]));
    }
    // Prints swing toward the camera so they never pass through a jug.
    // Into the Process trays the swing settles as (1 − e)^1.5, ahead of the arc height, so each
    // print is back over its tray before it dips below the rim (M2-AC5).
    if (k === 2) pos[2] += Math.sin(PI * e) * 1.6;
    if (k === 3) pos[2] += Math.sin(PI * e) * Math.sqrt(1 - e) * 1.9;
    const developing = k === 0 && t === 0 && options.developed !== true;
    return {
      pos,
      rot: lerp3(a.rot, b.rot, e),
      scale: lerp(a.s, b.s, e),
      atlasA: a.tex,
      atlasB: b.tex,
      mix: t > 0 ? tx * 1.4 - 0.2 : -0.3,
      develop: developing ? lerp(1, -0.3, clamp(p / 0.06)) : -0.3 + 0.45 * Math.sin(PI * clamp(tx)),
      lit,
    };
  });

  // Lamp: safelight ⇄ price timer ⇄ work light.
  const tl = tw("lamp");
  const tg = tw("light");
  const lampPos = lerp3(A.lamp.pos, B.lamp.pos, tl);
  const white = lerp(A.lamp.white, B.lamp.white, tg);
  const cordLength = Math.max(0.01, CEILING - lampPos[1] - LAMP_HANG);

  return {
    p,
    k,
    t,
    camera: { pos: camPos, target: camTgt, fov },
    vessels,
    tiles,
    lamp: {
      pos: lampPos,
      yaw: lerp(A.lamp.yaw, B.lamp.yaw, tl),
      timerOpacity: lerp(A.lamp.timer, B.lamp.timer, tl),
      safeColor: white > 0 ? [1, lerp(1, 1.25, white), lerp(1, 1.6, white)] : [1, 1, 1],
      glowOpacity: lerp(A.lamp.glow, B.lamp.glow, tl),
      glowPos: [lampPos[0] + 0.4, lampPos[1] + 0.6, lampPos[2] - 0.6],
      cordLength,
      cordPos: [lampPos[0], lampPos[1] + LAMP_HANG + cordLength / 2, lampPos[2]],
    },
    safe: {
      pos: [lampPos[0], lampPos[1], lampPos[2] + 1.2],
      intensity: lerp(A.safe, B.safe, tg),
      color: lerpColor(0xff_7a_2a, 0xff_d9_b0, white),
    },
    spot: {
      pos: lerp3(A.spot.pos, B.spot.pos, tg),
      target: lerp3(A.spot.tgt, B.spot.tgt, tg),
      intensity: lerp(A.spot.int, B.spot.int, tg),
      angle: lerp(A.spot.ang, B.spot.ang, tg),
      color: lerpColor(A.spot.col, B.spot.col, tg),
    },
    ambient: {
      color: lerpColor(A.amb.col, B.amb.col, tg),
      intensity: lerp(A.amb.int, B.amb.int, tg),
    },
    fill: lerp(A.fill, B.fill, tg),
    exposure: lerp(A.exp, B.exp, tg),
    background: lerpColor(A.bg, B.bg, tg),
  };
}

/** How much of the safelight stays when the visitor switches it off (face, glow, red light). */
export const SAFELIGHT_OFF_LEVEL = 0.12;

/**
 * The header's Safelight toggle as a pure modifier on top of `evaluate(p)`: switched off, the
 * lamp's face, glow sprite and red point light drop to `SAFELIGHT_OFF_LEVEL`. Nothing else in
 * the scene changes, and `evaluate(p)` itself stays a function of p only.
 */
export function applySafelight(state: SceneState, on: boolean): SceneState {
  if (on) return state;
  const f = SAFELIGHT_OFF_LEVEL;
  const face = 0.3 + 0.7 * f;
  return {
    ...state,
    lamp: {
      ...state.lamp,
      glowOpacity: state.lamp.glowOpacity * f,
      safeColor: [
        state.lamp.safeColor[0] * face,
        state.lamp.safeColor[1] * face,
        state.lamp.safeColor[2] * face,
      ],
    },
    safe: { ...state.safe, intensity: state.safe.intensity * f },
  };
}
