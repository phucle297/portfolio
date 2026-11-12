/**
 * The six print atlases (design.md §2 "Textures"), drawn at runtime from page fonts, so they
 * cost 0 KB to download. Each is a 2×2 atlas: tile i samples its own quadrant, laid out by
 * `SLOT` so prints read 01 → 04 left to right.
 *
 * The develop shader only reads the red channel, so atlases are stored as single-channel R8
 * (1 byte/texel) instead of RGBA8: the same image at a quarter of the VRAM. The sRGB → linear
 * decode that an sRGB CanvasTexture would do on the GPU is applied here with a lookup table.
 */
import { sceneText } from "@entities/profile";
import { SLOT } from "../model/keyframes";

/** Logical drawing size, in prototype units; the canvas is scaled to the real size. */
const LW = 2048;
const LH = 1462;
const PI = Math.PI;
const INK = "#111";
const PAPER = "#fff";

export interface AtlasData {
  width: number;
  height: number;
  /** Linear red channel, rows bottom-up (WebGL texture order). */
  data: Uint8Array;
}

export type Context2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
type Draw = (x: Context2D, w: number, h: number) => void;
type DrawQuad = (x: Context2D, w: number, h: number, i: number) => void;

const SRGB_TO_LINEAR = Uint8Array.from({ length: 256 }, (_, v) => {
  const c = v / 255;
  const linear = c < 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  return Math.round(linear * 255);
});

export const ATLAS_FONTS = ['400 200px "Anton"', '500 40px "IBM Plex Mono"'] as const;

/** Ensure the print faces are loaded before drawing (Anton is loaded only by the island). */
export async function loadAtlasFonts(): Promise<void> {
  const sample = "PHÚC LÊ 0123456789 $·–";
  await Promise.all(ATLAS_FONTS.map((font) => document.fonts.load(font, sample)));
}

function rasterize(ctx: Context2D, width: number, height: number, draw: Draw): AtlasData {
  ctx.save();
  ctx.scale(width / LW, height / LH);
  draw(ctx, LW, LH);
  ctx.restore();
  const rgba = ctx.getImageData(0, 0, width, height).data;
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const src = (height - 1 - y) * width * 4;
    const dst = y * width;
    for (let x = 0; x < width; x += 1) data[dst + x] = SRGB_TO_LINEAR[rgba[src + x * 4] ?? 0] ?? 0;
  }
  return { width, height, data };
}

const border = (x: Context2D, w: number, h: number, lw = 14): void => {
  x.lineWidth = lw;
  x.strokeStyle = INK;
  x.strokeRect(lw / 2 + 6, lw / 2 + 6, w - lw - 12, h - lw - 12);
};

const quad =
  (draw: DrawQuad): Draw =>
  (x, w, h) => {
    x.fillStyle = PAPER;
    x.fillRect(0, 0, w, h);
    for (let i = 0; i < 4; i += 1) {
      x.save();
      x.translate((i % 2) * (w / 2), (i >> 1) * (h / 2));
      draw(x, w / 2, h / 2, SLOT[i] ?? i);
      x.restore();
    }
  };

const at = <T>(list: readonly T[], i: number): T => {
  const item = list[i];
  if (item === undefined) throw new Error(`Missing atlas text ${i}`);
  return item;
};

/** No photo at launch (build plan Q1): the intro print is the starburst, name and role only. */
const intro: Draw = (x, w, h) => {
  x.fillStyle = PAPER;
  x.fillRect(0, 0, w, h);
  x.fillStyle = INK;
  for (let i = 0; i < 48; i += 1) {
    x.save();
    x.translate(w * 0.74, h * 0.4);
    x.rotate((i * PI) / 24);
    x.fillRect(0, -5, 1300, 10);
    x.restore();
  }
  x.fillStyle = PAPER;
  x.fillRect(50, h * 0.5, w * 0.72, h * 0.45);
  x.fillStyle = INK;
  x.font = '400 400px "Anton"';
  x.fillText(sceneText.intro.name, 96, h * 0.83);
  x.font = '500 62px "IBM Plex Mono"';
  x.fillText(sceneText.intro.role, 100, h * 0.92);
  border(x, w, h, 26);
};

const sheet = quad((x, w, h, i) => {
  const [year, label] = at(sceneText.frames, i);
  x.fillStyle = INK;
  x.fillRect(20, 20, w - 40, h - 40);
  x.fillStyle = PAPER;
  for (let s = 40; s < w - 40; s += 64) {
    x.fillRect(s, 34, 30, 22);
    x.fillRect(s, h - 56, 30, 22);
  }
  x.font = '400 300px "Anton"';
  x.fillText(year, 70, h * 0.68);
  x.font = '500 46px "IBM Plex Mono"';
  x.fillText(label, 76, h * 0.83);
  x.fillText(`${String(i + 1).padStart(2, "0")}A`, w - 150, 120);
});

/** No screenshots at launch (build plan Q4): the dark plate is plain print art. */
const cases = quad((x, w, h, i) => {
  const [title, meta] = at(sceneText.cases, i);
  x.fillStyle = INK;
  x.fillRect(40, 40, w - 80, h * 0.56);
  x.font = '400 130px "Anton"';
  x.fillText(title, 44, h * 0.8);
  x.font = '500 38px "IBM Plex Mono"';
  x.fillText(meta, 50, h * 0.92);
  x.fillText(`PRINT 0${i + 1}`, w - 250, h * 0.92);
  border(x, w, h);
});

const labels = quad((x, w, h, i) => {
  const label = at(sceneText.labels, i);
  x.fillStyle = i === 0 ? "#FFC24B" : "#FFF1E4";
  x.fillRect(0, 0, w, h);
  x.fillStyle = "#0E0A08";
  x.font = '500 52px "IBM Plex Mono"';
  x.fillText(`0${i + 1} · SERVICE`, 60, 110);
  x.font = `400 ${label.length > 9 ? 150 : 176}px "Anton"`;
  x.textAlign = "center";
  x.fillText(label, w / 2, h * 0.62);
  x.textAlign = "left";
  x.font = '500 44px "IBM Plex Mono"';
  x.fillText(sceneText.price, 60, h * 0.88);
  border(x, w, h, 10);
});

const steps = quad((x, w, h, i) => {
  const [number, verb, step] = at(sceneText.steps, i);
  x.fillStyle = INK;
  x.font = '400 440px "Anton"';
  x.fillText(number, 60, h * 0.78);
  x.font = '400 120px "Anton"';
  x.fillText(verb, 560, h * 0.42);
  x.font = '500 54px "IBM Plex Mono"';
  x.fillText(step, 566, h * 0.62);
  border(x, w, h);
});

const contactPrint: Draw = (x, w, h) => {
  const [first, second] = sceneText.contact;
  x.fillStyle = PAPER;
  x.fillRect(0, 0, w, h);
  x.fillStyle = INK;
  x.font = '400 330px "Anton"';
  x.fillText(first, 100, h * 0.42);
  x.fillText(second, 100, h * 0.74);
  x.font = '500 64px "IBM Plex Mono"';
  x.fillText(sceneText.price, 108, h * 0.88);
  border(x, w, h, 26);
};

/** Atlas order matches `AtlasIndex`: intro, contact sheet, cases, labels, steps, contact. */
const DRAWS: readonly Draw[] = [intro, sheet, cases, labels, steps, contactPrint];

/**
 * Draw all six atlases at `width × round(width · 1462 / 2048)`, reusing one 2D canvas.
 * Desktop uses 1536 (≈ 1536×1097), lite 1024 (≈ 1024×732), per design.md §11.10.
 */
export function drawAtlases(width: number): AtlasData[] {
  const height = Math.round((width * LH) / LW);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("2D canvas unavailable");
  const out = DRAWS.map((draw) => {
    ctx.clearRect(0, 0, width, height);
    return rasterize(ctx, width, height, draw);
  });
  canvas.width = 0;
  canvas.height = 0;
  return out;
}

/** Small RGBA textures for the lamp faces and glow (drawn once). */
export function drawCanvas(width: number, height: number, draw: Draw): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas unavailable");
  draw(ctx, width, height);
  return canvas;
}

export const safelightFace: Draw = (x, w, h) => {
  const g = x.createRadialGradient(w / 2, h / 2, 10, w / 2, h / 2, w * 0.6);
  g.addColorStop(0, "#FFB060");
  g.addColorStop(1, "#C04A12");
  x.fillStyle = g;
  x.fillRect(0, 0, w, h);
  x.fillStyle = "rgba(40,14,4,.35)";
  for (let y = 18; y < h; y += 30) x.fillRect(0, y, w, 6);
};

export const timerFace: Draw = (x, w, h) => {
  const [price, time] = sceneText.timer;
  x.fillStyle = "#120804";
  x.fillRect(0, 0, w, h);
  x.fillStyle = "#FFC24B";
  x.shadowColor = "#FF7A3D";
  x.shadowBlur = 18;
  x.font = '400 104px "Anton"';
  x.fillText(price, 28, 150);
  x.font = '500 36px "IBM Plex Mono"';
  x.fillText(time, 30, 236);
};

export const glowSprite: Draw = (x, w, h) => {
  const g = x.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
  g.addColorStop(0, "rgba(255,120,40,.9)");
  g.addColorStop(0.25, "rgba(255,100,30,.35)");
  g.addColorStop(1, "rgba(255,90,30,0)");
  x.fillStyle = g;
  x.fillRect(0, 0, w, h);
};
