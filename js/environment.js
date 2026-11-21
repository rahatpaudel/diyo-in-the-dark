/**
 * Forest / rock environment, built from the low-poly meadow GLB pack.
 *
 * Every prop is a single-mesh GLB. We load each variant once, normalise its
 * geometry (bake the Blender/Y-up rotation, drop the packed scene offset, put
 * the feet on y = 0), then draw all of its copies with InstancedMesh. The
 * positions themselves are not generated here: they come from
 * forest-data.js, which is baked offline so the world is identical on every
 * visit.
 *
 * Instances are also split into eight angular sectors. Frustum culling then
 * works per sector instead of testing one giant bounding sphere per variant,
 * which keeps both the main pass and the spotlight shadow pass cheap.
 */
import * as THREE from './vendor/three.module.js';
import { GLTFLoader } from './vendor/GLTFLoader.js';
import { FOREST } from './forest-data.js';
import { heightAt } from './terrain.js';
import { PATH_EXTRAS } from './path.js';

const MODEL_DIR = 'models/';
const SECTORS = 8;

// Browsers refuse cross-origin fetches for file:// pages, so every GLB would
// fail one by one and flood the console. Detect it once and fail cleanly.
const IS_FILE_PROTOCOL =
  typeof location !== 'undefined' && location.protocol === 'file:';

function kindOf(name) {
  if (name.startsWith('Pebbles')) return 'pebble';
  if (name.startsWith('Rock')) return 'rock';
  return 'tree';
}

// Auto-smooth angle per asset family, in degrees. The pack ships with flat
// (per-face) normals, which makes the low-poly canopies and boulders look
// faceted. Recomputing vertex normals and only splitting them across edges
// sharper than these limits gives the same result as Blender's "Shade Auto
// Smooth": soft, rounded foliage and bark, crisp rock corners and cut ends.
const SMOOTH_ANGLE = {
  tree: 60,
  rock: 40,
  pebble: 32
};

/* ------------------------------------------------------------------ */
/*  Blender-style auto-smooth normals                                  */
/* ------------------------------------------------------------------ */
/**
 * Rebuild `geometry` with angle-limited smooth vertex normals.
 *
 * Faces meeting at the same welded position are clustered while their
 * normals stay within `angleDeg` of the running cluster normal. Each cluster
 * contributes one averaged normal; a vertex that belongs to more than one
 * cluster is duplicated so the hard edge survives.
 */
function autoSmoothNormals(geometry, angleDeg) {
  const position = geometry.attributes.position;
  const index = geometry.index;
  const vCount = position.count;
  const triCount = (index ? index.count : vCount) / 3;
  if (!triCount) return geometry;

  const vertAt = (i) => (index ? index.getX(i) : i);

  // Area-weighted face normals (cross product, not yet normalised).
  const face = new Float32Array(triCount * 3);
  for (let t = 0; t < triCount; t++) {
    const a = vertAt(t * 3);
    const b = vertAt(t * 3 + 1);
    const c = vertAt(t * 3 + 2);
    const ax = position.getX(a), ay = position.getY(a), az = position.getZ(a);
    const bx = position.getX(b) - ax, by = position.getY(b) - ay, bz = position.getZ(b) - az;
    const cx = position.getX(c) - ax, cy = position.getY(c) - ay, cz = position.getZ(c) - az;
    face[t * 3] = by * cz - bz * cy;
    face[t * 3 + 1] = bz * cx - bx * cz;
    face[t * 3 + 2] = bx * cy - by * cx;
  }

  // Weld corners by position so flat-exported duplicates can share a normal.
  const Q = 1e4;
  const groupOf = new Int32Array(vCount);
  const groupKeys = new Map();
  const groups = [];
  for (let v = 0; v < vCount; v++) {
    const k =
      Math.round(position.getX(v) * Q) + ',' +
      Math.round(position.getY(v) * Q) + ',' +
      Math.round(position.getZ(v) * Q);
    let g = groupKeys.get(k);
    if (g === undefined) {
      g = groups.length;
      groupKeys.set(k, g);
      groups.push({ tris: [] });
    }
    groupOf[v] = g;
  }

  for (let t = 0; t < triCount; t++) {
    const seen = new Set();
    for (let k = 0; k < 3; k++) {
      const g = groupOf[vertAt(t * 3 + k)];
      if (seen.has(g)) continue;
      seen.add(g);
      groups[g].tris.push(t);
    }
  }

  // Cluster the faces around each position, stopping at the angle limit.
  const cosLimit = Math.cos((angleDeg * Math.PI) / 180);
  for (const group of groups) {
    const clusters = [];
    const clusterOfTri = new Map();
    for (const t of group.tris) {
      const nx = face[t * 3], ny = face[t * 3 + 1], nz = face[t * 3 + 2];
      const len = Math.hypot(nx, ny, nz);
      if (len === 0) continue;
      const ux = nx / len, uy = ny / len, uz = nz / len;

      let found = -1;
      for (let c = 0; c < clusters.length; c++) {
        const cl = clusters[c];
        const al = Math.hypot(cl.ax, cl.ay, cl.az) || 1;
        if (
          ux * (cl.ax / al) + uy * (cl.ay / al) + uz * (cl.az / al) >=
          cosLimit
        ) {
          found = c;
          break;
        }
      }
      if (found < 0) {
        found = clusters.length;
        clusters.push({ ax: 0, ay: 0, az: 0 });
      }
      const cl = clusters[found];
      cl.ax += nx;
      cl.ay += ny;
      cl.az += nz;
      clusterOfTri.set(t, found);
    }

    group.clusterOfTri = clusterOfTri;
    group.normals = clusters.map((cl) => {
      const l = Math.hypot(cl.ax, cl.ay, cl.az) || 1;
      return [cl.ax / l, cl.ay / l, cl.az / l];
    });
  }

  // Rebuild the attributes, duplicating a vertex per cluster when a hard
  // edge splits it.
  const copyNames = Object.keys(geometry.attributes).filter((n) => n !== 'normal');
  const out = {};
  for (const name of copyNames) {
    const a = geometry.attributes[name];
    out[name] = { size: a.itemSize, data: [] };
  }
  const normals = [];
  const outMap = new Map();
  const newIndex = [];

  const component = (a, v, c) =>
    c === 0 ? a.getX(v) : c === 1 ? a.getY(v) : c === 2 ? a.getZ(v) : a.getW(v);

  for (let t = 0; t < triCount; t++) {
    for (let k = 0; k < 3; k++) {
      const v = vertAt(t * 3 + k);
      const g = groupOf[v];
      const group = groups[g];
      let ci = group.clusterOfTri.get(t);
      if (ci === undefined) ci = 0;

      const key = v + ':' + g + ':' + ci;
      let ni = outMap.get(key);
      if (ni === undefined) {
        ni = normals.length / 3;
        outMap.set(key, ni);
        for (const name of copyNames) {
          const a = geometry.attributes[name];
          const rec = out[name];
          for (let c = 0; c < rec.size; c++) rec.data.push(component(a, v, c));
        }
        const n = group.normals[ci] || [0, 1, 0];
        normals.push(n[0], n[1], n[2]);
      }
      newIndex.push(ni);
    }
  }

  const smoothed = new THREE.BufferGeometry();
  for (const name of copyNames) {
    const rec = out[name];
    smoothed.setAttribute(
      name,
      new THREE.BufferAttribute(new Float32Array(rec.data), rec.size)
    );
  }
  smoothed.setAttribute(
    'normal',
    new THREE.BufferAttribute(new Float32Array(normals), 3)
  );
  smoothed.setIndex(newIndex);
  smoothed.computeBoundingBox();
  smoothed.computeBoundingSphere();
  geometry.dispose();
  return smoothed;
}

/* ------------------------------------------------------------------ */
/*  Load one variant, normalise its geometry                          */
/* ------------------------------------------------------------------ */
function prepare(gltf, kind) {
  let mesh = null;
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse((o) => {
    if (!mesh && o.isMesh) mesh = o;
  });
  if (!mesh) return null;

  const geometry = mesh.geometry.clone();

  // The exported node carries the pack's world translation plus the
  // Z-up -> Y-up rotation. Keep the rotation/scale, throw the translation
  // away so every copy can be placed independently.
  const bake = new THREE.Matrix4().copy(mesh.matrixWorld);
  bake.setPosition(0, 0, 0);
  geometry.applyMatrix4(bake);

  // Sit the model on y = 0 and centre it on its own footprint.
  geometry.computeBoundingBox();
  const bb = geometry.boundingBox;
  geometry.translate(
    -(bb.min.x + bb.max.x) / 2,
    -bb.min.y,
    -(bb.min.z + bb.max.z) / 2
  );
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  // Nothing in the pack needs the second UV set or the second colour set.
  ['uv1', 'tangent'].forEach((attr) => {
    if (geometry.attributes[attr]) geometry.deleteAttribute(attr);
  });
  if (geometry.attributes.color1) geometry.deleteAttribute('color1');

  // The pack ships flat-shaded, which is what makes the low-poly canopies
  // and boulders look faceted. Recompute vertex normals with an angle limit
  // so the result matches Blender's "Shade Auto Smooth".
  const smoothed = autoSmoothNormals(geometry, SMOOTH_ANGLE[kind] || 60);

  return { geometry: smoothed, material: mesh.material };
}

/* ------------------------------------------------------------------ */
/*  Build instanced meshes                                            */
/* ------------------------------------------------------------------ */
function sectorOf(x, z) {
  const a = Math.atan2(z, x) + Math.PI;
  return Math.min(SECTORS - 1, (a / (Math.PI * 2)) * SECTORS | 0);
}

/**
 * Broad-phase radius for a prop: the full XZ extent of its visible mesh.
 * Trees and rocks are tested against their actual triangles after this, so
 * this only has to be generous enough not to skip a nearby collider.
 */
export function loadEnvironment(scene, options = {}) {
  const loader = new GLTFLoader();
  const names = Object.keys(FOREST).filter((n) => n.startsWith('Tree_'));

  let done = 0;
  const report = () => {
    if (typeof options.onProgress === 'function') {
      options.onProgress(names.length ? done / names.length : 1);
    }
  };
  report();

  if (IS_FILE_PROTOCOL) {
    // No point starting seventeen requests that the browser will block.
    console.warn(
      '[environment] Models cannot be fetched over file://. ' +
        'Starting without the forest — run `node server.js` and open http://localhost:3000.'
    );
    return Promise.resolve(build(scene, Object.create(null), options));
  }

  return new Promise((resolve) => {
    const loaded = Object.create(null);

    const finish = () => {
      if (done < names.length) return;
      resolve(build(scene, loaded, options));
    };

    const settle = (name, gltf) => {
      loaded[name] = gltf || null;
      done++;
      report();
      finish();
    };

    for (const name of names) {
      loader.load(
        MODEL_DIR + name + '.glb',
        (gltf) => settle(name, gltf),
        undefined,
        (err) => {
          console.warn('[environment] could not load ' + name + '.glb', err && err.message);
          settle(name, null);
        }
      );
    }

    if (!names.length) finish();
  });
}

function build(scene, loaded, options) {
  const group = new THREE.Group();
  group.name = 'environment';

  let sharedMaterial = null;
  let maxAniso = 1;
  if (options.renderer && options.renderer.capabilities) {
    maxAniso = options.renderer.capabilities.getMaxAnisotropy();
  }

  const dummy = new THREE.Object3D();
  const stats = { variants: 0, instances: 0, missing: [], blocked: IS_FILE_PROTOCOL };
  const meshes = [];

  for (const name of Object.keys(loaded)) {
    const gltf = loaded[name];
    if (!gltf) {
      stats.missing.push(name);
      continue;
    }
    const kind = kindOf(name);
    const prepared = prepare(gltf, kind);
    if (!prepared) {
      stats.missing.push(name);
      continue;
    }
    stats.variants++;

    const items = (PATH_EXTRAS[name] || []).map((e) => [e.x, e.z, e.rot, e.scale]);

    // The opening ceremony's strike rock is the only baked prop retained.
    if (name === 'Tree_On_Rock' && FOREST[name] && FOREST[name].length) {
      const p = FOREST[name][0];
      items.push([p[0], p[1], p[2], p[3]]);
    }
    if (!items.length) continue;

    if (!sharedMaterial) {
      const src = prepared.material;
      const map = src && src.map ? src.map : null;
      if (map) {
        map.anisotropy = Math.min(4, maxAniso);
        map.needsUpdate = true;
      }
      sharedMaterial = new THREE.MeshStandardMaterial({
        map,
        vertexColors: true,
        color: 0xffffff,
        roughness: 0.92,
        metalness: 0,
        side: THREE.DoubleSide
      });
    }

    const buckets = Array.from({ length: SECTORS }, () => []);
    for (const p of items) buckets[sectorOf(p[0], p[1])].push(p);

    for (let s = 0; s < SECTORS; s++) {
      const bucket = buckets[s];
      if (!bucket.length) continue;

      const inst = new THREE.InstancedMesh(prepared.geometry, sharedMaterial, bucket.length);
      inst.name = name + '_s' + s;
      inst.castShadow = true;
      inst.receiveShadow = true;
      inst.instanceMatrix.setUsage(THREE.StaticDrawUsage);

      for (let i = 0; i < bucket.length; i++) {
        const [x, z, rot, scale] = bucket[i];
        const sink = name === 'Tree_On_Rock' ? 0 : 0.18;
        dummy.position.set(x, heightAt(x, z) - sink, z);
        dummy.rotation.set(0, rot, 0);
        dummy.scale.setScalar(scale);
        dummy.updateMatrix();
        inst.setMatrixAt(i, dummy.matrix);

        const h = Math.abs(Math.sin(i * 12.9898 + x * 78.233 + z * 37.719) * 43758.5453) % 1;
        const tint = 0.86 + h * 0.22;
        inst.setColorAt(i, new THREE.Color(tint, tint, tint));
      }
      inst.instanceMatrix.needsUpdate = true;
      if (inst.instanceColor) inst.instanceColor.needsUpdate = true;

      group.add(inst);
      meshes.push(inst);
      stats.instances += bucket.length;
    }
  }

  if (sharedMaterial) {
    for (const m of meshes) m.computeBoundingSphere();
  }

  scene.add(group);
  return { group, meshes, material: sharedMaterial, stats };
}
