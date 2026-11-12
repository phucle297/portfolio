/**
 * M1-AC5: at each key progress the resolved scene state equals the key-state data K[i]
 * (design.md §4) within 1e-3; colours within 1/255.
 */
import { describe, expect, it } from "vitest";
import { KEY_PROGRESS } from "@shared/lib/timeline";
import { evaluate, hexToLinear, type Rgb } from "../../src/_pages/home/model/evaluate";
import { KEYS, type Vec3 } from "../../src/_pages/home/model/keyframes";

const EPS = 1e-3;
const COLOR_EPS = 1 / 255;

const near = (actual: number, expected: number, eps = EPS): void => {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(eps);
};
const near3 = (actual: Vec3 | Rgb, expected: Vec3 | Rgb, eps = EPS): void => {
  actual.forEach((v, i) => {
    near(v, expected[i] ?? Number.NaN, eps);
  });
};

describe("key states", () => {
  it("has six key states, four vessels and four tiles each", () => {
    expect(KEYS).toHaveLength(6);
    for (const key of KEYS) {
      expect(key.ves).toHaveLength(4);
      expect(key.tiles).toHaveLength(4);
    }
  });

  KEY_PROGRESS.forEach((p, i) => {
    it(`state(${p}) equals K[${i}]`, () => {
      const K = KEYS[i];
      if (!K) throw new Error("missing key");
      const s = evaluate(p);
      near3(s.camera.pos, K.cam.pos);
      near3(s.camera.target, K.cam.tgt);
      near(s.camera.fov, K.cam.fov);
      s.vessels.forEach((v, j) => {
        const k = K.ves[j];
        if (!k) throw new Error("missing vessel");
        near3(v.pos, k.pos);
        near3(v.scl, k.scl);
        near(v.yaw, k.yaw);
        near3(v.color, hexToLinear(k.color), COLOR_EPS);
        near(v.lidOpacity, 1 - k.tray);
        near(v.capScale, 1 - k.tray);
        near(v.liquidOpacity, 0.2 * k.tray * (K.liq ?? 1));
      });
      s.tiles.forEach((t, j) => {
        const k = K.tiles[j];
        if (!k) throw new Error("missing tile");
        near3(t.pos, k.pos);
        near3(t.rot, k.rot);
        near(t.scale, k.s);
        expect(t.atlasA).toBe(k.tex);
        near(t.lit, K.lit);
        // Hello develops 1 → −0.3 across 0–6 % (kf-01 at 3 % shows .35); fully developed after.
        near(t.develop, i === 0 ? 0.35 : -0.3);
      });
      near3(s.lamp.pos, K.lamp.pos);
      near(s.lamp.yaw, K.lamp.yaw);
      near(s.lamp.timerOpacity, K.lamp.timer);
      near(s.lamp.glowOpacity, K.lamp.glow);
      near(s.safe.intensity, K.safe);
      near3(s.spot.pos, K.spot.pos);
      near3(s.spot.target, K.spot.tgt);
      near(s.spot.intensity, K.spot.int);
      near(s.spot.angle, K.spot.ang);
      near3(s.spot.color, hexToLinear(K.spot.col), COLOR_EPS);
      near3(s.ambient.color, hexToLinear(K.amb.col), COLOR_EPS);
      near(s.ambient.intensity, K.amb.int);
      near(s.fill, K.fill);
      near(s.exposure, K.exp);
      near3(s.background, hexToLinear(K.bg), COLOR_EPS);
    });
  });

  it("matches the design.md §4 camera table", () => {
    const cams = KEYS.map((k) => [k.cam.pos, k.cam.tgt]);
    expect(cams).toEqual([
      [
        [-2.7, 6.3, 6.8],
        [-1.25, 0.5, -0.5],
      ],
      [
        [0.5, 5.5, 3.9],
        [-1.3, 0, 0.15],
      ],
      [
        [0.6, 2.7, 8.4],
        [0.4, 2.3, -1.6],
      ],
      [
        [1, 3.3, 10.8],
        [0.9, 2.1, 0],
      ],
      [
        [0, 8.6, 12.9],
        [0, 1.9, 0],
      ],
      [
        [-3, 7.5, 6.9],
        [-1.2, 0.6, -0.6],
      ],
    ]);
  });

  it("is a pure function of p (same p, same state, any path)", () => {
    const ps = [0.9, 0.1, 0.5, 0.33, 0.77, 0.05];
    const first = ps.map((p) => JSON.stringify(evaluate(p)));
    const again = ps
      .toReversed()
      .map((p) => JSON.stringify(evaluate(p)))
      .toReversed();
    expect(again).toEqual(first);
  });
});
