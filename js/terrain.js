/**
 * Rolling forest floor: a deterministic heightfield with a flattened riddle
 * path, generated ground albedo, and a subtle normal map. All heights come
 * from one function, shared by the mesh, prop placement, and the player.
 */
import * as THREE from './vendor/three.module.js';
import {
  nearestPath,
  nearestDecision,
  PATH_SAMPLES,
  PATH_BRANCHES,
  PATH_DECISIONS,
  PATH_HALF_WIDTH
} from './path.js';

const SIZE = 220;
const SEGMENTS = 224;
const HALF = SIZE / 2;

/* ------------------------------------------------------------------ */
/*  Deterministic noise                                               */
/* ------------------------------------------------------------------ */
function hash2(ix, iy, seed) {
  let h = ix * 374761393 + iy * 668265263 + seed * 1442695041;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

const smooth = (t) => t * t * (3 - 2 * t);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const mix = (a, b, t) => a + (b - a) * t;

function noise2(x, y, seed) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = smooth(x - ix);
  const fy = smooth(y - iy);
  const v00 = hash2(ix, iy, seed);
  const v10 = hash2(ix + 1, iy, seed);
  const v01 = hash2(ix, iy + 1, seed);
  const v11 = hash2(ix + 1, iy + 1, seed);
  return mix(mix(v00, v10, fx), mix(v01, v11, fx), fy);
}

function fbm(x, y, octaves, seed) {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let f = 1;
  for (let i = 0; i < octaves; i++) {
    sum += noise2(x * f, y * f, seed + i * 131) * amp;
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return sum / norm;
}

function periodicNoise(x, y, period, seed) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const wrap = (i) => ((i % period) + period) % period;
  const grad = (gx, gy) => {
    const a = hash2(wrap(gx), wrap(gy), seed) * Math.PI * 2;
    return [Math.cos(a), Math.sin(a)];
  };
  const ux = smooth(fx);
  const uy = smooth(fy);
  const g00 = grad(ix, iy);
  const g10 = grad(ix + 1, iy);
  const g01 = grad(ix, iy + 1);
  const g11 = grad(ix + 1, iy + 1);
  const n00 = g00[0] * fx + g00[1] * fy;
  const n10 = g10[0] * (fx - 1) + g10[1] * fy;
  const n01 = g01[0] * fx + g01[1] * (fy - 1);
  const n11 = g11[0] * (fx - 1) + g11[1] * (fy - 1);
  const n = mix(mix(n00, n10, ux), mix(n01, n11, ux), uy);
  return clamp01(n * 0.75 + 0.5);
}

function periodicFbm(u, v, period, octaves, seed) {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let p = period;
  for (let i = 0; i < octaves; i++) {
    sum += periodicNoise(u * p, v * p, p, seed + i * 197) * amp;
    norm += amp;
    amp *= 0.5;
    p *= 2;
  }
  return sum / norm;
}

/* ------------------------------------------------------------------ */
/*  Heights                                                           */
/* ------------------------------------------------------------------ */
function macroHeight(x, z) {
  const broad = fbm(x * 0.026 + 11.3, z * 0.026 - 4.7, 4, 1337);
  const mid = fbm(x * 0.085 + 3.1, z * 0.085 + 8.2, 3, 991);
  return (broad - 0.5) * 2.9 + (mid - 0.5) * 0.75;
}

function baseHeight(x, z) {
  const fine = fbm(x * 0.24 - 2.0, z * 0.24 + 1.3, 3, 353);
  // Extra relief away from the trail keeps the path comfortable while the
  // forest floor around it rolls more.
  const near = nearestPath(x, z, 9);
  const away = near ? smooth(clamp01((near.dist - 3.0) / 5.0)) : 1;
  const bump =
    (fbm(x * 0.16 + 7.3, z * 0.16 - 9.1, 3, 441) - 0.5) *
    0.6 *
    away;
  return macroHeight(x, z) + (fine - 0.5) * 0.22 + bump;
}

// Path heights are the smooth macro ground, sampled once per path point so
// the trail is comfortable rather than repeating the fine surface noise.
for (const s of PATH_SAMPLES) s.h = macroHeight(s.x, s.z);

/** Final height including path flattening and the spawn/house clearings. */
function finalHeight(x, z) {
  let h = baseHeight(x, z);

  const near = nearestPath(x, z, 4.5);
  if (near) {
    const blend = 1 - smooth(clamp01((near.dist - 1.6) / 1.6));
    h = mix(h, near.sample.h, blend);
  }

  const node = nearestDecision(x, z, 5);
  if (node) {
    const blend = 1 - smooth(clamp01((node.dist - 2.4) / 1.8));
    h = mix(h, macroHeight(node.node.x, node.node.z), blend);
  }

  // Keep the opening strike framing and the house on level ground.
  const spawn = Math.hypot(x, z);
  const spawnBlend = 1 - smooth(clamp01((spawn - 4.5) / 4.5));
  h = mix(h, 0, spawnBlend);

  const house = Math.hypot(x - 25, z - 25);
  const houseBlend = 1 - smooth(clamp01((house - 4.5) / 4.0));
  h = mix(h, 0, houseBlend);

  return h;
}

/* ------------------------------------------------------------------ */
/*  Generated ground textures                                          */
/* ------------------------------------------------------------------ */
function createGroundTextures(renderer) {
  const size = 1024;
  const albedoCanvas = document.createElement('canvas');
  albedoCanvas.width = albedoCanvas.height = size;
  const normalCanvas = document.createElement('canvas');
  normalCanvas.width = normalCanvas.height = size;

  const actx = albedoCanvas.getContext('2d');
  const nctx = normalCanvas.getContext('2d');
  const aimg = actx.createImageData(size, size);
  const nimg = nctx.createImageData(size, size);
  const heights = new Float32Array(size * size);

  const soil = [48, 40, 30];
  const moss = [55, 68, 43];
  const leaf = [65, 49, 33];
  const light = [81, 66, 46];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      const broad = periodicFbm(u, v, 8, 5, 101);
      const patch = periodicFbm(u, v, 16, 4, 717);
      const fine = periodicFbm(u, v, 64, 3, 913);

      const mossMix = smooth(clamp01((broad - 0.34) / 0.36));
      const leafMix = smooth(clamp01((patch - 0.56) / 0.28));
      let r = mix(soil[0], moss[0], mossMix);
      let g = mix(soil[1], moss[1], mossMix);
      let b = mix(soil[2], moss[2], mossMix);
      r = mix(r, leaf[0], leafMix * 0.6);
      g = mix(g, leaf[1], leafMix * 0.6);
      b = mix(b, leaf[2], leafMix * 0.6);

      const grain = (fine - 0.5) * 16 + (patch - 0.5) * 9;
      const speck = fine > 0.86 ? (fine - 0.86) * 110 : 0;
      r = Math.max(0, Math.min(255, r + grain + speck * 0.7));
      g = Math.max(0, Math.min(255, g + grain + speck * 0.55));
      b = Math.max(0, Math.min(255, b + grain * 0.8 + speck * 0.35));

      // Sparse pale leaf litter.
      if (fine > 0.92) {
        r = mix(r, light[0], 0.4);
        g = mix(g, light[1], 0.35);
        b = mix(b, light[2], 0.3);
      }

      const i = (y * size + x) * 4;
      aimg.data[i] = r;
      aimg.data[i + 1] = g;
      aimg.data[i + 2] = b;
      aimg.data[i + 3] = 255;

      heights[y * size + x] =
        broad * 0.35 + patch * 0.45 + fine * 0.2;
    }
  }

  const wrap = (i) => (i + size) % size;
  const strength = 0.8;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const hL = heights[y * size + wrap(x - 1)];
      const hR = heights[y * size + wrap(x + 1)];
      const hD = heights[wrap(y - 1) * size + x];
      const hU = heights[wrap(y + 1) * size + x];
      let nx = (hL - hR) * strength;
      let ny = (hD - hU) * strength;
      let nz = 1;
      const inv = 1 / Math.hypot(nx, ny, nz);
      nx *= inv;
      ny *= inv;
      nz *= inv;
      const i = (y * size + x) * 4;
      nimg.data[i] = (nx * 0.5 + 0.5) * 255;
      nimg.data[i + 1] = (ny * 0.5 + 0.5) * 255;
      nimg.data[i + 2] = (nz * 0.5 + 0.5) * 255;
      nimg.data[i + 3] = 255;
    }
  }

  actx.putImageData(aimg, 0, 0);
  nctx.putImageData(nimg, 0, 0);

  // World-space path mask for a faint warm trail that survives the darkness.
  const pathCanvas = document.createElement('canvas');
  pathCanvas.width = pathCanvas.height = size;
  const pctx = pathCanvas.getContext('2d');
  pctx.clearRect(0, 0, size, size);
  pctx.lineCap = 'round';
  pctx.lineJoin = 'round';

  const px = (x) => ((x + HALF) / SIZE) * size;
  const py = (z) => ((z + HALF) / SIZE) * size;
  const coreWidth = ((PATH_HALF_WIDTH * 2) / SIZE) * size;

  for (const branch of PATH_BRANCHES) {
    pctx.strokeStyle = 'rgb(48, 48, 48)';
    pctx.lineWidth = coreWidth * 1.18;
    pctx.beginPath();
    branch.samples.forEach((s, i) => {
      if (i === 0) pctx.moveTo(px(s.x), py(s.z));
      else pctx.lineTo(px(s.x), py(s.z));
    });
    pctx.stroke();

    pctx.strokeStyle = 'rgb(255, 255, 255)';
    pctx.lineWidth = coreWidth;
    pctx.beginPath();
    branch.samples.forEach((s, i) => {
      if (i === 0) pctx.moveTo(px(s.x), py(s.z));
      else pctx.lineTo(px(s.x), py(s.z));
    });
    pctx.stroke();
  }

  // Widen the choice clearings slightly; the crossing branch strokes already
  // brighten the fork, so a solid soft disc is enough.
  for (const d of PATH_DECISIONS) {
    pctx.fillStyle = 'rgb(44, 44, 44)';
    pctx.beginPath();
    pctx.arc(px(d.x), py(d.z), (3.0 / SIZE) * size, 0, Math.PI * 2);
    pctx.fill();
  }

  // Build a textured warm emissive from the albedo, masked to the path, so
  // the trail glows without turning into a flat beige strip.
  const maskData = pctx.getImageData(0, 0, size, size).data;
  const emissiveCanvas = document.createElement('canvas');
  emissiveCanvas.width = emissiveCanvas.height = size;
  const ectx = emissiveCanvas.getContext('2d');
  const eimg = ectx.createImageData(size, size);
  for (let i = 0; i < aimg.data.length; i += 4) {
    const m = maskData[i] / 255;
    const p = i / 4;
    const u = (p % size) / size;
    const v = Math.floor(p / size) / size;
    const grain = periodicNoise(u * 192, v * 192, 192, 527);
    const g = 0.70 + grain * 0.60;
    // Warm dirt base with a little of the surrounding albedo mixed in.
    const r = (aimg.data[i] * 0.3 + 205 * 0.7) * g;
    const gg = (aimg.data[i + 1] * 0.3 + 150 * 0.7) * g;
    const b = (aimg.data[i + 2] * 0.3 + 92 * 0.7) * g;
    eimg.data[i] = Math.min(255, r * m);
    eimg.data[i + 1] = Math.min(255, gg * m);
    eimg.data[i + 2] = Math.min(255, b * m);
    eimg.data[i + 3] = 255;
  }
  ectx.putImageData(eimg, 0, 0);

  const maxAniso = renderer && renderer.capabilities
    ? Math.min(8, renderer.capabilities.getMaxAnisotropy())
    : 1;

  const albedo = new THREE.CanvasTexture(albedoCanvas);
  albedo.colorSpace = THREE.SRGBColorSpace;
  albedo.wrapS = albedo.wrapT = THREE.RepeatWrapping;
  albedo.repeat.set(8, 8);
  albedo.anisotropy = maxAniso;
  albedo.needsUpdate = true;

  const normal = new THREE.CanvasTexture(normalCanvas);
  normal.colorSpace = THREE.NoColorSpace;
  normal.wrapS = normal.wrapT = THREE.RepeatWrapping;
  normal.repeat.set(8, 8);
  normal.anisotropy = maxAniso;
  normal.needsUpdate = true;

  const emissive = new THREE.CanvasTexture(emissiveCanvas);
  emissive.colorSpace = THREE.SRGBColorSpace;
  emissive.flipY = false;
  emissive.wrapS = emissive.wrapT = THREE.ClampToEdgeWrapping;
  emissive.repeat.set(1, 1);
  emissive.anisotropy = maxAniso;
  emissive.needsUpdate = true;

  return { albedo, normal, emissive };
}

/* ------------------------------------------------------------------ */
/*  Terrain mesh + height lookup                                      */
/* ------------------------------------------------------------------ */
let heightGrid = null;

function gridHeightAt(x, z) {
  if (!heightGrid) return finalHeight(x, z);
  const gx = clamp01((x + HALF) / SIZE) * SEGMENTS;
  const gz = clamp01((z + HALF) / SIZE) * SEGMENTS;
  const ix = Math.min(SEGMENTS - 1, Math.floor(gx));
  const iz = Math.min(SEGMENTS - 1, Math.floor(gz));
  const fx = gx - ix;
  const fz = gz - iz;
  const n = SEGMENTS + 1;
  const h00 = heightGrid[iz * n + ix];
  const h10 = heightGrid[iz * n + ix + 1];
  const h01 = heightGrid[(iz + 1) * n + ix];
  const h11 = heightGrid[(iz + 1) * n + ix + 1];
  return mix(mix(h00, h10, fx), mix(h01, h11, fx), fz);
}

/** World-space terrain height. Safe to call after buildTerrain(). */
export function heightAt(x, z) {
  return gridHeightAt(x, z);
}

export function buildTerrain(scene, renderer) {
  const n = SEGMENTS + 1;
  const count = n * n;
  heightGrid = new Float32Array(count);

  const positions = new Float32Array(count * 3);
  const uvs = new Float32Array(count * 2);

  for (let iz = 0; iz < n; iz++) {
    const z = -HALF + (iz / SEGMENTS) * SIZE;
    for (let ix = 0; ix < n; ix++) {
      const x = -HALF + (ix / SEGMENTS) * SIZE;
      const h = finalHeight(x, z);
      const i = iz * n + ix;
      heightGrid[i] = h;
      positions[i * 3] = x;
      positions[i * 3 + 1] = h;
      positions[i * 3 + 2] = z;
      uvs[i * 2] = ix / SEGMENTS;
      uvs[i * 2 + 1] = iz / SEGMENTS;
    }
  }

  const indices = new Uint32Array(SEGMENTS * SEGMENTS * 6);
  let p = 0;
  for (let iz = 0; iz < SEGMENTS; iz++) {
    for (let ix = 0; ix < SEGMENTS; ix++) {
      const a = iz * n + ix;
      const b = a + 1;
      const c = a + n;
      const d = c + 1;
      indices[p++] = a;
      indices[p++] = c;
      indices[p++] = b;
      indices[p++] = b;
      indices[p++] = c;
      indices[p++] = d;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  geo.computeVertexNormals();

  // Large-scale moss / dirt / leaf-litter variation in vertex colour.
  const colors = new Float32Array(count * 3);
  const cSoil = new THREE.Color(0xb7a184);
  const cMoss = new THREE.Color(0x9caf82);
  const cLeaf = new THREE.Color(0xa98a68);
  const cPath = new THREE.Color(0xd0a877);
  const c = new THREE.Color();
  const normals = geo.attributes.normal;

  for (let i = 0; i < count; i++) {
    const x = positions[i * 3];
    const z = positions[i * 3 + 2];
    const broad = fbm(x * 0.055 + 4.1, z * 0.055 - 2.8, 3, 451);
    const patch = fbm(x * 0.14 - 1.7, z * 0.14 + 6.3, 3, 619);

    c.copy(cSoil).lerp(cMoss, smooth(clamp01((broad - 0.28) / 0.46)));
    c.lerp(cLeaf, 0.28 * smooth(clamp01((patch - 0.5) / 0.45)));

    const near = nearestPath(x, z, 4.5);
    let pathMask = near
      ? 1 - smooth(clamp01((near.dist - 1.15) / 1.15))
      : 0;
    const node = nearestDecision(x, z, 5);
    if (node) {
      pathMask = Math.max(
        pathMask,
        1 - smooth(clamp01((node.dist - 2.2) / 1.0))
      );
    }
    c.lerp(cPath, pathMask * 0.85);

    const ny = normals.getY(i);
    const slope = 0.58 + 0.42 * clamp01((ny - 0.5) / 0.5);
    c.multiplyScalar(slope);

    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  const textures = createGroundTextures(renderer);
  const material = new THREE.MeshStandardMaterial({
    map: textures.albedo,
    normalMap: textures.normal,
    normalScale: new THREE.Vector2(0.14, 0.14),
    emissive: new THREE.Color(0xffffff),
    emissiveMap: textures.emissive,
    emissiveIntensity: 0.65,
    vertexColors: true,
    roughness: 0.95,
    metalness: 0,
    color: 0xffffff
  });

  const mesh = new THREE.Mesh(geo, material);
  mesh.name = 'Terrain';
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  scene.add(mesh);
  return mesh;
}
