/**
 * M1-AC4: the scene graph is built once; applying any sequence of states never adds, removes or
 * creates objects, geometries or textures.
 */
import { BufferGeometry, Material, Mesh, Sprite, Texture, type Object3D } from "three";
import { describe, expect, it } from "vitest";
import { evaluate } from "../../src/_pages/home/model/evaluate";
import { buildSceneGraph } from "../../src/_pages/home/lib/scene-graph";

function inventory(root: Object3D): { objects: number; geometries: number; materials: number } {
  const geometries = new Set<string>();
  const materials = new Set<string>();
  let objects = 0;
  root.traverse((o) => {
    objects += 1;
    if ("geometry" in o && o.geometry instanceof BufferGeometry) geometries.add(o.geometry.uuid);
    if ("material" in o && o.material instanceof Material) materials.add(o.material.uuid);
  });
  return { objects, geometries: geometries.size, materials: materials.size };
}

const textures = () => ({
  atlases: Array.from({ length: 6 }, () => new Texture()),
  safelight: new Texture(),
  timer: new Texture(),
  glow: new Texture(),
});

describe("scene graph", () => {
  it("builds every design.md §2 object once", () => {
    const graph = buildSceneGraph(textures(), { liquidSegments: [48, 36] });
    const children = graph.scene.children;
    const lights = children.filter((c) => "isLight" in c && c.isLight === true);
    expect(lights).toHaveLength(4); // ambient, safelight point, spot, fill
    let meshes = 0;
    graph.scene.traverse((o) => {
      if (o instanceof Mesh) meshes += 1;
    });
    // bench, wall, 4 × (body, lid, liquid), 4 caps, 4 tiles, line, 4 pins, tongs,
    // lamp body, 2 lamp faces, cord = 32 meshes; plus 1 glow sprite.
    expect(meshes).toBe(32);
    const sprites = children.filter((c) => c instanceof Sprite);
    expect(sprites).toHaveLength(1);
  });

  it("keeps the graph unchanged across set(p) in any order, back and forth", () => {
    const graph = buildSceneGraph(textures(), { liquidSegments: [48, 36] });
    const before = inventory(graph.scene);
    const childCount = graph.scene.children.length;
    const ps = [0, 0.03, 0.21, 0.41, 0.6, 0.76, 0.96, 1];
    for (let round = 0; round < 3; round += 1) {
      for (const p of [...ps, ...ps.toReversed(), 0.5, 0.115, 0.855]) {
        graph.apply(evaluate(p));
      }
    }
    expect(graph.scene.children.length).toBe(childCount);
    expect(inventory(graph.scene)).toEqual(before);
  });
});
