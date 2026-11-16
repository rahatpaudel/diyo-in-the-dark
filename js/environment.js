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

/* ------------------------------------------------------------------ */
/*  Load one variant, normalise its geometry                          */
/* ------------------------------------------------------------------ */
function prepare(gltf) {
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

  return { geometry, material: mesh.material };
}

/* ------------------------------------------------------------------ */
/*  Build instanced meshes                                            */
/* ------------------------------------------------------------------ */
function sectorOf(x, z) {
  const a = Math.atan2(z, x) + Math.PI;
  return Math.min(SECTORS - 1, (a / (Math.PI * 2)) * SECTORS | 0);
}

/**
 * @param {THREE.Scene} scene
 * @param {object} options
 * @param {THREE.WebGLRenderer} [options.renderer] used for anisotropy
 * @param {(p:number)=>void} [options.onProgress] 0..1 as files arrive
 * @returns {Promise<{group:THREE.Group, meshes:Array, stats:object}>}
 */
export function loadEnvironment(scene, options = {}) {
  const loader = new GLTFLoader();
  const names = Object.keys(FOREST);

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

  // One shared material: the pack uses the same 32x32 palette atlas for
  // every prop and tints it with vertex colours.
  let sharedMaterial = null;
  let maxAniso = 1;
  if (options.renderer && options.renderer.capabilities) {
    maxAniso = options.renderer.capabilities.getMaxAnisotropy();
  }

  const dummy = new THREE.Object3D();
  const stats = { variants: 0, instances: 0, missing: [], blocked: IS_FILE_PROTOCOL };
  const meshes = [];

  for (const name of Object.keys(FOREST)) {
    const list = FOREST[name];
    const gltf = loaded[name];
    if (!gltf) {
      stats.missing.push(name);
      continue;
    }
    const prepared = prepare(gltf);
    if (!prepared) {
      stats.missing.push(name);
      continue;
    }
    stats.variants++;

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

    const kind = kindOf(name);

    // Bucket the fixed layout by sector so culling can throw away most of
    // the forest while the player faces one way.
    const buckets = Array.from({ length: SECTORS }, () => []);
    for (const p of list) {
      buckets[sectorOf(p[0], p[1])].push(p);
    }

    for (let s = 0; s < SECTORS; s++) {
      const bucket = buckets[s];
      if (!bucket.length) continue;

      const inst = new THREE.InstancedMesh(prepared.geometry, sharedMaterial, bucket.length);
      inst.name = name + '_s' + s;
      inst.castShadow = kind !== 'pebble';
      inst.receiveShadow = true;
      inst.instanceMatrix.setUsage(THREE.StaticDrawUsage);

      for (let i = 0; i < bucket.length; i++) {
        const [x, z, rot, scale] = bucket[i];
        dummy.position.set(x, 0, z);
        dummy.rotation.set(0, rot, 0);
        dummy.scale.setScalar(scale);
        dummy.updateMatrix();
        inst.setMatrixAt(i, dummy.matrix);

        // Break up the repetition with a faint brightness jitter.
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
    // Frustum/shadow culling needs valid bounds on every instanced mesh.
    for (const m of meshes) m.computeBoundingSphere();
  }

  scene.add(group);
  return { group, meshes, material: sharedMaterial, stats };
}
