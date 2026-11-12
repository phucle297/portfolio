import { DoubleSide, ShaderMaterial, Vector2, type Texture } from "three";

const NOISE = /* glsl */ `
float h(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float n(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);
  return mix(mix(h(i),h(i+vec2(1,0)),f.x),mix(h(i+vec2(0,1)),h(i+vec2(1,1)),f.x),f.y);}
`;

const VERTEX = /* glsl */ `
varying vec2 vUv;
void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}
`;

/**
 * "Develop-morph": crossfades two atlases through a noisy develop front (`uMix`) while `uP`
 * thins the image toward paper and back, so textures never cut (design.md §3).
 */
const FRAGMENT = /* glsl */ `
uniform sampler2D mA,mB;uniform float uMix,uP,uLit,uSeed;uniform vec2 uQ;varying vec2 vUv;
${NOISE}
void main(){vec2 q=uQ+vUv*.5; float a=texture2D(mA,q).r, b=texture2D(mB,q).r;
  float nz=n((q+uSeed)*6.)*.7+n((q+uSeed)*18.)*.3;
  float sw=1.-smoothstep(uMix-.18,uMix+.18,nz*.6+vUv.x*.4); float im=mix(a,b,sw);
  float dev=smoothstep(uP-.25,uP+.05,1.-nz*.9-(1.-q.x)*.25);
  vec3 safe=mix(vec3(.09,.035,.02),vec3(1.,.62,.3),im); vec3 day=mix(vec3(.10,.07,.05),vec3(1.,.93,.84),im);
  vec3 dens=mix(vec3(1.,.62,.3),safe,dev); vec3 c=mix(dens,day,uLit); c*=.86+.14*n(q*vec2(80.,60.));
  gl_FragColor=vec4(pow(c,vec3(2.2)),1.);}
`;

export interface TileUniforms {
  [uniform: string]: { value: unknown };
  mA: { value: Texture | null };
  mB: { value: Texture | null };
  uMix: { value: number };
  uP: { value: number };
  uLit: { value: number };
  uQ: { value: Vector2 };
  uSeed: { value: number };
}

export interface TileMaterial {
  material: ShaderMaterial;
  uniforms: TileUniforms;
}

/** Material for tile i (quadrant TL, TR, BL, BR of the print). */
export function createTileMaterial(i: number): TileMaterial {
  const col = i % 2;
  const row = i >> 1;
  const uniforms: TileUniforms = {
    mA: { value: null },
    mB: { value: null },
    uMix: { value: 0 },
    uP: { value: -0.3 },
    uLit: { value: 0 },
    uQ: { value: new Vector2(col * 0.5, (1 - row) * 0.5) },
    uSeed: { value: i * 1.7 },
  };
  const material = new ShaderMaterial({
    side: DoubleSide,
    uniforms,
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
  });
  return { material, uniforms };
}
