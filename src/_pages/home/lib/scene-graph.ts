/**
 * The persistent scene graph (design.md §2). Every object is built exactly once here; `apply()`
 * only copies an `evaluate(p)` result onto it. Nothing is created, added or removed afterwards.
 * Independent of the renderer and the DOM, so it can be built in unit tests with dummy textures.
 */
import {
  AdditiveBlending,
  BufferGeometry,
  Material,
  AmbientLight,
  BoxGeometry,
  CylinderGeometry,
  DirectionalLight,
  Fog,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  PointLight,
  Scene,
  SpotLight,
  Sprite,
  SpriteMaterial,
  Color,
  LinearSRGBColorSpace,
  type Texture,
} from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { TILE_H, TILE_W, VESSEL_COUNT, TILE_COUNT } from "../model/keyframes";
import type { Rgb, SceneState } from "../model/evaluate";
import { createTileMaterial, type TileUniforms } from "./tile-material";

const PI = Math.PI;
const DARK = 0x2a_1a_12;
const BG = 0x0e_0a_08;

export interface GraphTextures {
  /** Six print atlases in `AtlasIndex` order. */
  atlases: readonly Texture[];
  safelight: Texture;
  timer: Texture;
  glow: Texture;
}

export interface GraphOptions {
  /** Liquid surface segments: 48×36 full, 24×18 lite. */
  liquidSegments: readonly [number, number];
}

interface Vessel {
  group: Group;
  material: MeshPhysicalMaterial;
  lid: Mesh<PlaneGeometry, MeshPhysicalMaterial>;
  liquid: Mesh<PlaneGeometry, MeshStandardMaterial>;
  cap: Mesh<BoxGeometry, MeshStandardMaterial>;
}

interface Tile {
  mesh: Mesh;
  uniforms: TileUniforms;
}

export interface SceneGraph {
  scene: Scene;
  camera: PerspectiveCamera;
  apply: (state: SceneState) => void;
  /** Tone-mapping exposure for the renderer (the graph does not own the renderer). */
  exposure: () => number;
  dispose: () => void;
}

const setColor = (color: Color, [r, g, b]: Rgb): void => {
  color.setRGB(r, g, b, LinearSRGBColorSpace);
};

/** One tray/jug body: four walls and a floor merged into a single geometry (1 draw call). */
function vesselBody(): BufferGeometry {
  const t = 0.03;
  const f = 0.12;
  const parts: [number, number, number, number, number, number][] = [
    [0, 0, 0.5 - t / 2, 1, 1, t],
    [0, 0, -0.5 + t / 2, 1, 1, t],
    [0.5 - t / 2, 0, 0, t, 1, 1],
    [-0.5 + t / 2, 0, 0, t, 1, 1],
    [0, -0.5 + f / 2, 0, 1, f, 1],
  ];
  const boxes = parts.map(([x, y, z, w, h, d]) => new BoxGeometry(w, h, d).translate(x, y, z));
  const merged = mergeGeometries(boxes);
  for (const box of boxes) box.dispose();
  if (!merged) throw new Error("Could not merge vessel geometry");
  return merged;
}

/** Baked ripple on the bath surface (no per-frame animation). */
function liquidGeometry([sx, sy]: readonly [number, number]): PlaneGeometry {
  const geometry = new PlaneGeometry(1, 1, sx, sy);
  const position = geometry.attributes.position;
  if (position) {
    for (let k = 0; k < position.count; k += 1) {
      const d = Math.hypot(position.getX(k) - 0.2, position.getY(k) + 0.12);
      position.setZ(k, 0.004 * Math.sin(d * 40) * Math.exp(-d * 2));
    }
  }
  geometry.computeVertexNormals();
  return geometry;
}

export function buildSceneGraph(textures: GraphTextures, options: GraphOptions): SceneGraph {
  const scene = new Scene();
  const background = new Color(BG);
  scene.background = background;
  const fog = new Fog(BG, 12, 32);
  scene.fog = fog;
  const camera = new PerspectiveCamera(34, 16 / 10, 0.1, 100);

  const bench = new Mesh(
    new PlaneGeometry(60, 60),
    new MeshStandardMaterial({ color: 0x1a_11_0c, roughness: 0.6 }),
  );
  bench.rotation.x = -PI / 2;
  scene.add(bench);

  const wall = new Mesh(
    new PlaneGeometry(60, 20),
    new MeshStandardMaterial({ color: 0x14_0d_0a, roughness: 0.9 }),
  );
  wall.position.set(0, 10, -5);
  scene.add(wall);

  // Shared geometries: one body, lid and liquid shape for all four vessels.
  const bodyGeometry = vesselBody();
  const lidGeometry = new PlaneGeometry(1, 1);
  const liquidShape = liquidGeometry(options.liquidSegments);
  const capGeometry = new BoxGeometry(0.42, 0.28, 0.42);

  const vessels: Vessel[] = Array.from({ length: VESSEL_COUNT }, () => {
    const group = new Group();
    const material = new MeshPhysicalMaterial({
      color: DARK,
      roughness: 0.32,
      clearcoat: 1,
      clearcoatRoughness: 0.2,
    });
    group.add(new Mesh(bodyGeometry, material));
    const lid = new Mesh(
      lidGeometry,
      new MeshPhysicalMaterial({ color: DARK, roughness: 0.32, clearcoat: 1, transparent: true }),
    );
    lid.rotation.x = -PI / 2;
    lid.position.y = 0.5;
    group.add(lid);
    const liquid = new Mesh(
      liquidShape,
      new MeshStandardMaterial({
        color: 0xff_a0_60,
        transparent: true,
        opacity: 0.2,
        roughness: 0.3,
        metalness: 0,
        depthWrite: false,
      }),
    );
    liquid.rotation.x = -PI / 2;
    liquid.position.y = 0.05;
    liquid.scale.set(0.94, 0.94, 1);
    group.add(liquid);
    const cap = new Mesh(
      capGeometry,
      new MeshStandardMaterial({ color: 0x1a_11_0c, roughness: 0.5 }),
    );
    scene.add(cap);
    scene.add(group);
    return { group, material, lid, liquid, cap };
  });

  const tileGeometry = new PlaneGeometry(TILE_W, TILE_H, 1, 8);
  const tiles: Tile[] = Array.from({ length: TILE_COUNT }, (_, i) => {
    const { material, uniforms } = createTileMaterial(i);
    const mesh = new Mesh(tileGeometry, material);
    mesh.rotation.order = "YXZ";
    scene.add(mesh);
    return { mesh, uniforms };
  });

  const line = new Mesh(
    new CylinderGeometry(0.018, 0.018, 16, 8),
    new MeshStandardMaterial({ color: 0x6a_4a_34 }),
  );
  line.rotation.z = PI / 2;
  line.position.set(0, 3.38, -1.6);
  scene.add(line);

  const pinGeometry = new BoxGeometry(0.2, 0.34, 0.1);
  const pinMaterial = new MeshStandardMaterial({ color: 0xff_7a_3d, roughness: 0.5 });
  for (let i = 0; i < 4; i += 1) {
    const pin = new Mesh(pinGeometry, pinMaterial);
    pin.position.set(-3.15 + i * 2.1, 3.22, -1.57);
    scene.add(pin);
  }

  const tongs = new Mesh(
    new BoxGeometry(2.4, 0.05, 0.12),
    new MeshStandardMaterial({ color: 0xff_c2_4b, roughness: 0.4 }),
  );
  tongs.position.set(2.7, 0.04, 2.4);
  tongs.rotation.y = -0.5;
  scene.add(tongs);

  // Safelight ⇄ price timer ⇄ work light, hanging from its cord.
  const lamp = new Group();
  scene.add(lamp);
  lamp.add(
    new Mesh(
      new BoxGeometry(1.9, 1.25, 0.8),
      new MeshStandardMaterial({ color: DARK, roughness: 0.4 }),
    ),
  );
  const faceGeometry = new PlaneGeometry(1.6, 0.95);
  const faceSafe = new Mesh(
    faceGeometry,
    new MeshBasicMaterial({ map: textures.safelight, toneMapped: false }),
  );
  faceSafe.position.z = 0.41;
  lamp.add(faceSafe);
  const faceTimer = new Mesh(
    faceGeometry,
    new MeshBasicMaterial({ map: textures.timer, transparent: true, toneMapped: false }),
  );
  faceTimer.position.z = 0.415;
  lamp.add(faceTimer);

  const cord = new Mesh(
    new CylinderGeometry(0.02, 0.02, 1, 6),
    new MeshStandardMaterial({ color: 0x3a_2a_22 }),
  );
  scene.add(cord);

  const glow = new Sprite(
    new SpriteMaterial({
      map: textures.glow,
      blending: AdditiveBlending,
      depthWrite: false,
      transparent: true,
    }),
  );
  glow.scale.set(6, 6, 1);
  scene.add(glow);

  const ambient = new AmbientLight(0xff_9a_50, 0.25);
  scene.add(ambient);
  const safe = new PointLight(0xff_7a_2a, 60, 30, 1.4);
  scene.add(safe);
  const spot = new SpotLight(0xff_b0_70, 80, 30, 0.5, 0.6, 1.4);
  scene.add(spot);
  scene.add(spot.target);
  const fill = new DirectionalLight(0xff_9a_50, 0);
  fill.position.set(2, 6, 6);
  scene.add(fill);

  let exposure = 1.1;

  function apply(state: SceneState): void {
    const { camera: cam } = state;
    camera.fov = cam.fov;
    camera.position.set(...cam.pos);
    camera.lookAt(...cam.target);
    camera.updateProjectionMatrix();

    vessels.forEach((vessel, i) => {
      const v = state.vessels[i];
      if (!v) return;
      vessel.group.position.set(...v.pos);
      vessel.group.scale.set(...v.scl);
      vessel.group.rotation.y = v.yaw;
      setColor(vessel.material.color, v.color);
      vessel.lid.material.color.copy(vessel.material.color);
      vessel.lid.material.opacity = v.lidOpacity;
      vessel.lid.visible = v.lidOpacity > 0.001;
      vessel.liquid.material.opacity = v.liquidOpacity;
      vessel.liquid.visible = v.liquidOpacity > 0.0002;
      vessel.cap.visible = v.capScale > 0.001;
      vessel.cap.scale.setScalar(v.capScale);
      vessel.cap.position.set(...v.capPos);
    });

    tiles.forEach((tile, i) => {
      const s = state.tiles[i];
      if (!s) return;
      tile.mesh.position.set(...s.pos);
      tile.mesh.rotation.set(...s.rot);
      tile.mesh.scale.setScalar(s.scale);
      tile.uniforms.mA.value = textures.atlases[s.atlasA] ?? null;
      tile.uniforms.mB.value = textures.atlases[s.atlasB] ?? null;
      tile.uniforms.uMix.value = s.mix;
      tile.uniforms.uP.value = s.develop;
      tile.uniforms.uLit.value = s.lit;
    });

    const l = state.lamp;
    lamp.position.set(...l.pos);
    lamp.rotation.y = l.yaw;
    faceTimer.material.opacity = l.timerOpacity;
    faceTimer.visible = l.timerOpacity > 0.001;
    setColor(faceSafe.material.color, l.safeColor);
    cord.scale.y = l.cordLength;
    cord.position.set(...l.cordPos);
    glow.position.set(...l.glowPos);
    glow.material.opacity = l.glowOpacity;

    safe.position.set(...state.safe.pos);
    safe.intensity = state.safe.intensity;
    setColor(safe.color, state.safe.color);
    spot.position.set(...state.spot.pos);
    spot.target.position.set(...state.spot.target);
    spot.intensity = state.spot.intensity;
    spot.angle = state.spot.angle;
    setColor(spot.color, state.spot.color);
    setColor(ambient.color, state.ambient.color);
    ambient.intensity = state.ambient.intensity;
    fill.intensity = state.fill;
    exposure = state.exposure;
    setColor(background, state.background);
    fog.color.copy(background);
  }

  function dispose(): void {
    const owned = new Set<BufferGeometry | Material>();
    scene.traverse((object) => {
      if ("geometry" in object && object.geometry instanceof BufferGeometry) {
        owned.add(object.geometry);
      }
      if ("material" in object && object.material instanceof Material) {
        owned.add(object.material);
      }
    });
    for (const resource of owned) resource.dispose();
    for (const texture of [
      ...textures.atlases,
      textures.safelight,
      textures.timer,
      textures.glow,
    ]) {
      texture.dispose();
    }
  }

  return { scene, camera, apply, exposure: () => exposure, dispose };
}
