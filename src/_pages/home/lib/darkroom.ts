/**
 * Renderer + textures around the persistent scene graph. Entry point of the lazy three.js chunk.
 */
import {
  ACESFilmicToneMapping,
  CanvasTexture,
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  NoColorSpace,
  RedFormat,
  SRGBColorSpace,
  UnsignedByteType,
  WebGLRenderer,
  type Texture,
} from "three";
import { applySafelight, evaluate, type SceneState } from "../model/evaluate";
import {
  drawAtlases,
  drawCanvas,
  glowSprite,
  loadAtlasFonts,
  safelightFace,
  timerFace,
  type AtlasData,
} from "./atlases";
import { buildSceneGraph } from "./scene-graph";
import { TIERS, type Tier } from "./tiers";

export interface RenderInfo {
  calls: number;
  triangles: number;
  textures: number;
  geometries: number;
  programs: number;
  /** Objects in the scene graph (constant after init). */
  objects: number;
  /** Estimated texture VRAM in bytes (see `estimateTextureBytes`). */
  textureBytes: number;
}

export interface Darkroom {
  readonly tier: Tier;
  set: (p: number) => void;
  /** Safelight on/off; takes effect on the next `set`. */
  setSafelight: (on: boolean) => void;
  render: () => RenderInfo;
  resize: (width: number, height: number) => void;
  state: () => SceneState;
  info: () => RenderInfo;
  dispose: () => void;
}

const MIP_FACTOR = 4 / 3;

/** Texture memory estimate: Σ width × height × bytes/texel × 4/3 (full mip chain). */
export function estimateTextureBytes(
  textures: readonly { width: number; height: number; bytesPerTexel: number }[],
): number {
  return Math.round(
    textures.reduce((sum, t) => sum + t.width * t.height * t.bytesPerTexel * MIP_FACTOR, 0),
  );
}

function atlasTexture({ width, height, data }: AtlasData): DataTexture {
  const texture = new DataTexture(data, width, height, RedFormat, UnsignedByteType);
  texture.colorSpace = NoColorSpace;
  texture.unpackAlignment = 1;
  texture.generateMipmaps = true;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.magFilter = LinearFilter;
  texture.anisotropy = 8;
  texture.needsUpdate = true;
  return texture;
}

function canvasTexture(canvas: HTMLCanvasElement): CanvasTexture {
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

export async function createDarkroom(
  canvas: HTMLCanvasElement,
  { tier, width, height }: { tier: Tier; width: number; height: number },
): Promise<Darkroom> {
  const config = TIERS[tier];
  await loadAtlasFonts();

  const atlasData = drawAtlases(config.atlasWidth);
  const atlases: Texture[] = atlasData.map(atlasTexture);
  const small = {
    safelight: canvasTexture(drawCanvas(512, 300, safelightFace)),
    timer: canvasTexture(drawCanvas(512, 300, timerFace)),
    glow: canvasTexture(drawCanvas(256, 256, glowSprite)),
  };
  const textureBytes = estimateTextureBytes([
    ...atlasData.map((a) => ({ width: a.width, height: a.height, bytesPerTexel: 1 })),
    { width: 512, height: 300, bytesPerTexel: 4 },
    { width: 512, height: 300, bytesPerTexel: 4 },
    { width: 256, height: 256, bytesPerTexel: 4 },
  ]);

  const renderer = new WebGLRenderer({
    canvas,
    antialias: config.antialias,
    powerPreference: "high-performance",
  });
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, config.maxPixelRatio));
  renderer.setSize(width, height, false);

  const graph = buildSceneGraph({ atlases, ...small }, { liquidSegments: config.liquidSegments });
  graph.camera.aspect = width / height;

  let aspect = width / height;
  let current = evaluate(0);
  let safelight = true;
  const set = (p: number): void => {
    current = evaluate(p, { portrait: config.portraitFraming && aspect < 1 });
    graph.apply(applySafelight(current, safelight));
    renderer.toneMappingExposure = graph.exposure();
  };
  const countObjects = (): number => {
    let n = 0;
    graph.scene.traverse(() => {
      n += 1;
    });
    return n;
  };
  const info = (): RenderInfo => ({
    calls: renderer.info.render.calls,
    triangles: renderer.info.render.triangles,
    textures: renderer.info.memory.textures,
    geometries: renderer.info.memory.geometries,
    programs: renderer.info.programs?.length ?? 0,
    objects: countObjects(),
    textureBytes,
  });

  set(0);
  await renderer.compileAsync(graph.scene, graph.camera);

  return {
    tier,
    set,
    setSafelight: (on) => {
      safelight = on;
    },
    render: () => {
      renderer.render(graph.scene, graph.camera);
      return info();
    },
    resize: (w, h) => {
      aspect = w / h;
      renderer.setSize(w, h, false);
      graph.camera.aspect = aspect;
      graph.camera.updateProjectionMatrix();
    },
    state: () => applySafelight(current, safelight),
    info,
    dispose: () => {
      graph.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
}
