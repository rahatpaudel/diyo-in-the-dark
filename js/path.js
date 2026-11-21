/**
 * Long riddle trail from the spawn to the rebuilt house.
 *
 * The path is the only walkable surface: movement is clamped to its corridor,
 * so the dense forest beside it is decoration rather than collision geometry.
 * Five decisions give 2/2/2/3/3 options. Decoys curve away and end at a log.
 */
import * as THREE from './vendor/three.module.js';

export const PATH_HALF_WIDTH = 1.25;
export const HOUSE_POINT = { x: 0, z: -168 };

const SAMPLE_STEP = 0.6;
const CELL = 4;
const PATH_MARGIN = 0.35;

export const PATH_DECISIONS = [
  { id: 'q1', x: 1.5, z: -24, riddle: 1, choices: 2 },
  { id: 'q2', x: -1.5, z: -48, riddle: 2, choices: 2 },
  { id: 'q3', x: 2, z: -72, riddle: 3, choices: 2 },
  { id: 'q4', x: -2, z: -96, riddle: 4, choices: 3 },
  { id: 'q5', x: 1, z: -120, riddle: 5, choices: 3 }
];

const BRANCHES = [
  {
    id: 'start',
    kind: 'correct',
    points: [
      [0, 0],
      [1, -8],
      [-1, -15],
      [1.5, -24]
    ]
  },
  {
    id: 'q1-correct',
    kind: 'correct',
    points: [
      [1.5, -24],
      [0, -34],
      [-2.5, -41],
      [-1.5, -48]
    ]
  },
  {
    id: 'q1-decoy',
    kind: 'decoy',
    points: [
      [1.5, -24],
      [6, -27],
      [10, -31],
      [13, -36]
    ]
  },
  {
    id: 'q2-correct',
    kind: 'correct',
    points: [
      [-1.5, -48],
      [-0.5, -58],
      [2.5, -66],
      [2, -72]
    ]
  },
  {
    id: 'q2-decoy',
    kind: 'decoy',
    points: [
      [-1.5, -48],
      [-6, -50],
      [-10, -54],
      [-13, -60]
    ]
  },
  {
    id: 'q3-correct',
    kind: 'correct',
    points: [
      [2, -72],
      [0.5, -82],
      [-2.5, -89],
      [-2, -96]
    ]
  },
  {
    id: 'q3-decoy',
    kind: 'decoy',
    points: [
      [2, -72],
      [7, -75],
      [11, -79],
      [14, -84]
    ]
  },
  {
    id: 'q4-correct',
    kind: 'correct',
    points: [
      [-2, -96],
      [0, -106],
      [-1, -113],
      [1, -120]
    ]
  },
  {
    id: 'q4-east',
    kind: 'decoy',
    points: [
      [-2, -96],
      [3, -98],
      [7, -101],
      [10, -106]
    ]
  },
  {
    id: 'q4-west',
    kind: 'decoy',
    points: [
      [-2, -96],
      [-7, -98],
      [-11, -102],
      [-14, -108]
    ]
  },
  {
    id: 'q5-east',
    kind: 'correct',
    points: [
      [1, -120],
      [7, -126],
      [10, -134],
      [6, -142],
      [-2, -147],
      [-5, -154],
      [-2, -160],
      [0, -163.5]
    ]
  },
  {
    id: 'q5-middle',
    kind: 'decoy',
    points: [
      [1, -120],
      [0, -126],
      [-4, -131],
      [-8, -137],
      [-8, -143]
    ]
  },
  {
    id: 'q5-west',
    kind: 'decoy',
    points: [
      [1, -120],
      [-6, -123],
      [-11, -129],
      [-14, -136],
      [-18, -144],
      [-17, -151]
    ]
  }
];

/* ------------------------------------------------------------------ */
/*  Sampled centerlines                                               */
/* ------------------------------------------------------------------ */
export const PATH_BRANCHES = [];
export const PATH_SAMPLES = [];

for (const def of BRANCHES) {
  const curve = new THREE.CatmullRomCurve3(
    def.points.map(([x, z]) => new THREE.Vector3(x, 0, z)),
    false,
    'catmullrom',
    0.5
  );
  const length = curve.getLength();
  const count = Math.max(2, Math.ceil(length / SAMPLE_STEP));
  const points = curve.getSpacedPoints(count);
  const samples = points.map((p, i) => ({
    x: p.x,
    z: p.z,
    t: i / count,
    branch: def.id,
    h: 0
  }));

  const branch = {
    id: def.id,
    kind: def.kind,
    points: def.points,
    samples,
    length
  };
  PATH_BRANCHES.push(branch);
  for (const s of samples) PATH_SAMPLES.push(s);
}

for (const d of PATH_DECISIONS) {
  d.options = PATH_BRANCHES.filter(
    (b) => b.points[0][0] === d.x && b.points[0][1] === d.z
  ).map((b) => ({
    id: b.id,
    correct: b.kind === 'correct',
    length: Math.round(b.length * 10) / 10
  }));
}

/* ------------------------------------------------------------------ */
/*  Nearest-path lookup                                               */
/* ------------------------------------------------------------------ */
const pathGrid = new Map();
const cellKey = (x, z) => `${x}:${z}`;

for (let i = 0; i < PATH_SAMPLES.length; i++) {
  const s = PATH_SAMPLES[i];
  const key = cellKey(Math.floor(s.x / CELL), Math.floor(s.z / CELL));
  let bucket = pathGrid.get(key);
  if (!bucket) {
    bucket = [];
    pathGrid.set(key, bucket);
  }
  bucket.push(i);
}

export function nearestPath(x, z, maxDist = 6) {
  const range = Math.ceil(maxDist / CELL);
  const cx = Math.floor(x / CELL);
  const cz = Math.floor(z / CELL);
  let bestD2 = maxDist * maxDist;
  let best = -1;
  for (let ix = cx - range; ix <= cx + range; ix++) {
    for (let iz = cz - range; iz <= cz + range; iz++) {
      const bucket = pathGrid.get(cellKey(ix, iz));
      if (!bucket) continue;
      for (let j = 0; j < bucket.length; j++) {
        const s = PATH_SAMPLES[bucket[j]];
        const dx = s.x - x;
        const dz = s.z - z;
        const d2 = dx * dx + dz * dz;
        if (d2 < bestD2) {
          bestD2 = d2;
          best = bucket[j];
        }
      }
    }
  }
  if (best < 0) return null;
  return {
    dist: Math.sqrt(bestD2),
    sample: PATH_SAMPLES[best],
    branch: PATH_SAMPLES[best].branch
  };
}

export function nearestDecision(x, z, maxDist = 6) {
  let best = null;
  let bestD2 = maxDist * maxDist;
  for (const d of PATH_DECISIONS) {
    const dx = d.x - x;
    const dz = d.z - z;
    const d2 = dx * dx + dz * dz;
    if (d2 < bestD2) {
      bestD2 = d2;
      best = d;
    }
  }
  return best ? { dist: Math.sqrt(bestD2), node: best } : null;
}

/* ------------------------------------------------------------------ */
/*  Dense path-side forest                                            */
/* ------------------------------------------------------------------ */
const TREES = [
  { name: 'Tree_Small_1', radius: 2.04 },
  { name: 'Tree_Small_2', radius: 3.41 },
  { name: 'Tree_Bare_1', radius: 2.02 },
  { name: 'Tree_Bare_2', radius: 3.41 },
  { name: 'Tree_Large_1', radius: 2.11 },
  { name: 'Tree_Large_2', radius: 2.47 },
  { name: 'Tree_Stump', radius: 0.64 }
];
const PATH_TREES = TREES.slice(0, 6);
const EDGE_TREES = [TREES[0], TREES[2], TREES[4]];

function hash(a, b, c) {
  let h = a * 374761393 + b * 668265263 + c * 1442695041;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

export const PATH_EXTRAS = Object.create(null);
const addExtra = (name, x, z, rot, scale) => {
  const list = PATH_EXTRAS[name] || (PATH_EXTRAS[name] = []);
  list.push({ x, z, rot, scale });
};

function nearSpawnOrHouse(x, z) {
  if (Math.hypot(x, z) < 2.0) return true;
  if (Math.hypot(x - HOUSE_POINT.x, z - HOUSE_POINT.z) < 8.5) return true;
  return false;
}

for (const branch of PATH_BRANCHES) {
  const isDecoy = branch.kind === 'decoy';
  const steps = [
    { step: 2.4, side: 0, pool: EDGE_TREES, lo: 0.42, hi: 0.68 },
    { step: 3.4, side: 1, pool: PATH_TREES, lo: 0.65, hi: 0.95 },
    { step: 5.0, side: 2, pool: PATH_TREES, lo: 0.85, hi: 1.2 },
    { step: 7.0, side: 3, pool: PATH_TREES, lo: 1.0, hi: 1.4 },
    { step: 9.5, side: 4, pool: PATH_TREES, lo: 1.0, hi: 1.5 },
    { step: 12.0, side: 5, pool: PATH_TREES, lo: 1.0, hi: 1.5 },
    { step: 14.5, side: 6, pool: PATH_TREES, lo: 1.0, hi: 1.5 },
    { step: 17.0, side: 7, pool: PATH_TREES, lo: 1.0, hi: 1.5 }
  ];

  for (const row of steps) {
    const indexStep = Math.max(1, Math.round(row.step / SAMPLE_STEP));
    for (let i = indexStep; i < branch.samples.length - 1; i += indexStep) {
      const s = branch.samples[i];
      const prev = branch.samples[i - 1];
      const next = branch.samples[i + 1];
      let dx = next.x - prev.x;
      let dz = next.z - prev.z;
      const len = Math.hypot(dx, dz) || 1;
      dx /= len;
      dz /= len;

      if (nearSpawnOrHouse(s.x, s.z)) continue;
      if (isDecoy && i > branch.samples.length - 3) continue;

      for (const side of [-1, 1]) {
        const key = i * 3 + row.side + (side > 0 ? 11 : 0);
        if (hash(key, side, branch.id.length * 41) < 0.18) continue;

        const variant = row.pool[(key + (side > 0 ? 3 : 0)) % row.pool.length];
        const scale = row.lo + hash(key, side, 911) * (row.hi - row.lo);
        const extra = [0.9, 1.4, 2.8, 4.8, 7.0, 9.0, 11.0, 13.0][row.side];
        const offset = variant.radius * scale + PATH_HALF_WIDTH + extra;
        const nx = s.x - dz * side * offset;
        const nz = s.z + dx * side * offset;
        if (nearSpawnOrHouse(nx, nz)) continue;

        const other = nearestPath(nx, nz, offset + 4);
        if (other && other.dist < PATH_HALF_WIDTH + PATH_MARGIN + 0.3) continue;

        addExtra(
          variant.name,
          nx,
          nz,
          hash(key, side, 613) * Math.PI * 2,
          scale
        );
      }
    }
  }
}

// Forest behind the spawn. Turning around should show deep woods, not the
// edge of the terrain.
for (let gx = -34; gx <= 34; gx += 3.8) {
  for (let gz = 2; gz <= 40; gz += 3.8) {
    const r1 = hash(Math.round(gx * 10), Math.round(gz * 10), 211);
    const r2 = hash(Math.round(gx * 10), Math.round(gz * 10), 307);
    const r3 = hash(Math.round(gx * 10), Math.round(gz * 10), 401);
    if (r1 < 0.16) continue;
    const x = gx + (r2 - 0.5) * 3.2;
    const z = gz + (r3 - 0.5) * 3.2;
    if (Math.hypot(x, z) < 4.5) continue;
    const v = PATH_TREES[Math.floor(r2 * PATH_TREES.length) % PATH_TREES.length];
    addExtra(v.name, x, z, r3 * Math.PI * 2, 0.85 + r1 * 0.55);
  }
}

// Decoy ends: a fallen log and a tight knot of trees, no collision needed.
for (const branch of PATH_BRANCHES) {
  if (branch.kind !== 'decoy') continue;
  const end = branch.samples[branch.samples.length - 1];
  const prev = branch.samples[branch.samples.length - 3] || branch.samples[0];
  let dx = end.x - prev.x;
  let dz = end.z - prev.z;
  const len = Math.hypot(dx, dz) || 1;
  dx /= len;
  dz /= len;
  const px = -dz;
  const pz = dx;
  const across = Math.atan2(px, pz);

  addExtra('Tree_Fallen', end.x, end.z, across, 1.0);
  addExtra('Tree_Large_1', end.x + dx * 2.4 + px * 0.7, end.z + dz * 2.4 + pz * 0.7, hash(end.x, end.z, 1) * Math.PI * 2, 1.0);
  addExtra('Tree_Small_2', end.x + dx * 2.1 - px * 1.1, end.z + dz * 2.1 - pz * 1.1, hash(end.x, end.z, 2) * Math.PI * 2, 0.9);
  addExtra('Tree_Small_1', end.x - dx * 1.2 + px * 1.4, end.z - dz * 1.2 + pz * 1.4, hash(end.x, end.z, 3) * Math.PI * 2, 0.8);
}

export function pathSummary() {
  return {
    decisions: PATH_DECISIONS.map((d) => ({ ...d })),
    branches: PATH_BRANCHES.map((b) => ({
      id: b.id,
      kind: b.kind,
      length: b.length
    }))
  };
}
