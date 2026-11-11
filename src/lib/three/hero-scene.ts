/**
 * Hero WebGL scene. This module (and three.js with it) is only ever loaded through a dynamic
 * `import()` from the HeroScene island, so it lives in its own lazily fetched chunk.
 */
import {
  AdditiveBlending,
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  IcosahedronGeometry,
  Mesh,
  PerspectiveCamera,
  Points,
  PointsMaterial,
  Scene,
  ShaderMaterial,
  Timer,
  WebGLRenderer,
} from "three";
import { hasHardwareWebGL } from "./webgl-support";

export interface HeroSceneOptions {
  /** Live media query for `prefers-reduced-motion: reduce`. */
  reducedMotion: MediaQueryList;
  /** Upper bound for the renderer pixel ratio. */
  maxPixelRatio?: number;
}

export interface HeroSceneHandle {
  dispose: () => void;
}

const vertexShader = /* glsl */ `
  uniform float uTime;
  varying vec3 vNormal;
  varying vec3 vView;
  varying float vDisplacement;

  void main() {
    vec3 p = position;
    float d = sin(p.x * 2.1 + uTime * 0.9) * sin(p.y * 2.3 + uTime * 0.7) * sin(p.z * 1.9 + uTime * 0.8);
    d += 0.35 * sin(p.y * 5.0 - uTime * 1.3);
    p += normal * d * 0.16;
    vDisplacement = d;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    vView = normalize(-mv.xyz);
    vNormal = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * mv;
  }
`;

const fragmentShader = /* glsl */ `
  uniform vec3 uColorA;
  uniform vec3 uColorB;
  varying vec3 vNormal;
  varying vec3 vView;
  varying float vDisplacement;

  void main() {
    float fresnel = pow(1.0 - max(dot(normalize(vNormal), normalize(vView)), 0.0), 2.2);
    vec3 base = mix(uColorA, uColorB, smoothstep(-0.8, 0.8, vDisplacement));
    vec3 color = base * (0.28 + fresnel * 1.35);
    gl_FragColor = vec4(color, 1.0);
  }
`;

function createStarfield(count: number): BufferGeometry {
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    // Deterministic pseudo-random distribution on a spherical shell.
    const u = Math.sin(i * 12.9898) * 43758.5453;
    const v = Math.sin(i * 78.233) * 12345.6789;
    const theta = (u - Math.floor(u)) * Math.PI * 2;
    const phi = Math.acos(2 * (v - Math.floor(v)) - 1);
    const r = 3.2 + ((i * 0.618) % 1) * 2.4;
    positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
    positions[i * 3 + 2] = r * Math.cos(phi);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  return geometry;
}

/**
 * Mount the scene inside `host`. Resolves to `null` when hardware WebGL is unavailable so the
 * CSS poster stays visible.
 */
export async function mountHeroScene(
  host: HTMLElement,
  { reducedMotion, maxPixelRatio = 1.5 }: HeroSceneOptions,
): Promise<HeroSceneHandle | null> {
  if (!hasHardwareWebGL()) return null;

  let renderer: WebGLRenderer;
  try {
    renderer = new WebGLRenderer({
      antialias: window.devicePixelRatio < 2,
      alpha: true,
      powerPreference: "low-power",
      failIfMajorPerformanceCaveat: true,
    });
  } catch {
    return null;
  }

  renderer.setPixelRatio(Math.min(window.devicePixelRatio, maxPixelRatio));
  renderer.setClearColor(0x000000, 0);
  const canvas = renderer.domElement;
  canvas.setAttribute("aria-hidden", "true");
  canvas.classList.add("hero-scene__canvas");

  const scene = new Scene();
  const camera = new PerspectiveCamera(40, 1, 0.1, 50);
  camera.position.set(0, 0, 6);

  const blobGeometry = new IcosahedronGeometry(1.35, 32);
  const blobMaterial = new ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: {
      uTime: { value: 0 },
      uColorA: { value: new Color("#3b82f6") },
      uColorB: { value: new Color("#c084fc") },
    },
  });
  const blob = new Mesh(blobGeometry, blobMaterial);
  scene.add(blob);

  const starGeometry = createStarfield(900);
  const starMaterial = new PointsMaterial({
    color: new Color("#9fb8ff"),
    size: 0.02,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.7,
    depthWrite: false,
    blending: AdditiveBlending,
  });
  const stars = new Points(starGeometry, starMaterial);
  scene.add(stars);

  const timer = new Timer();
  timer.connect(document);
  const pointer = { x: 0, y: 0, tx: 0, ty: 0 };

  const resize = (): void => {
    const { clientWidth, clientHeight } = host;
    if (clientWidth === 0 || clientHeight === 0) return;
    camera.aspect = clientWidth / clientHeight;
    // Keep the blob framed on narrow (portrait) screens.
    camera.position.z = camera.aspect < 1 ? 6 / Math.max(camera.aspect, 0.55) : 6;
    camera.updateProjectionMatrix();
    renderer.setSize(clientWidth, clientHeight, false);
  };

  const renderFrame = (): void => {
    timer.update();
    const elapsed = timer.getElapsed();
    const delta = Math.min(timer.getDelta(), 1 / 20);
    pointer.x += (pointer.tx - pointer.x) * Math.min(delta * 3, 1);
    pointer.y += (pointer.ty - pointer.y) * Math.min(delta * 3, 1);

    const uniforms = blobMaterial.uniforms as { uTime: { value: number } };
    uniforms.uTime.value = elapsed;
    blob.rotation.y = elapsed * 0.12 + pointer.x * 0.4;
    blob.rotation.x = pointer.y * 0.3;
    stars.rotation.y = -elapsed * 0.02 + pointer.x * 0.1;
    stars.rotation.x = pointer.y * 0.05;
    renderer.render(scene, camera);
  };

  let onScreen = true;
  let running = false;

  const shouldAnimate = (): boolean => onScreen && !document.hidden && !reducedMotion.matches;

  const sync = (): void => {
    const next = shouldAnimate();
    if (next === running) return;
    running = next;
    if (running) {
      timer.reset();
      renderer.setAnimationLoop(renderFrame);
    } else {
      renderer.setAnimationLoop(null);
    }
  };

  const onPointerMove = (event: PointerEvent): void => {
    pointer.tx = (event.clientX / window.innerWidth) * 2 - 1;
    pointer.ty = (event.clientY / window.innerHeight) * 2 - 1;
  };

  const onMotionPreferenceChange = (): void => {
    if (reducedMotion.matches) renderFrame();
    sync();
  };

  const intersection = new IntersectionObserver(
    (entries) => {
      onScreen = entries.some((entry) => entry.isIntersecting);
      sync();
    },
    { threshold: 0 },
  );
  const resizeObserver = new ResizeObserver(() => {
    resize();
    if (!running) renderFrame();
  });

  resize();
  // Compile shaders off the main thread where KHR_parallel_shader_compile is supported.
  await renderer.compileAsync(scene, camera);
  host.appendChild(canvas);
  // Always paint one frame so reduced-motion users get a static render.
  renderFrame();
  requestAnimationFrame(() => {
    host.classList.add("is-ready");
  });

  intersection.observe(host);
  resizeObserver.observe(host);
  document.addEventListener("visibilitychange", sync);
  reducedMotion.addEventListener("change", onMotionPreferenceChange);
  window.addEventListener("pointermove", onPointerMove, { passive: true });
  sync();

  let disposed = false;
  return {
    dispose: () => {
      if (disposed) return;
      disposed = true;
      renderer.setAnimationLoop(null);
      intersection.disconnect();
      resizeObserver.disconnect();
      document.removeEventListener("visibilitychange", sync);
      reducedMotion.removeEventListener("change", onMotionPreferenceChange);
      window.removeEventListener("pointermove", onPointerMove);
      timer.dispose();
      blobGeometry.dispose();
      blobMaterial.dispose();
      starGeometry.dispose();
      starMaterial.dispose();
      renderer.dispose();
      canvas.remove();
      host.classList.remove("is-ready");
    },
  };
}
