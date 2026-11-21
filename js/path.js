/**
 * Long riddle trail from the spawn to the rebuilt house.
 *
 * The path is the only walkable surface: movement is clamped to its corridor,
 * so the dense forest beside it is decoration rather than collision geometry.
 * Five decisions give 2/2/2/3/3 options. Decoys curve away and end at a log.
 */
import * as THREE from './vendor/three.module.js';

export const PATH_HALF_WIDTH = 1.25;
export const HOUSE_POINT = { x: 0, z: -98 };

const SAMPLE_STEP = 0.6;
const CELL = 4;
const PATH_MARGIN = 0.35;

export const PATH_DECISIONS = [
  { id: 'q1', x: 1.5, z: -16, riddle: 1, choices: 2 },
  { id: 'q2', x: -1.5, z: -32, riddle: 2, choices: 2 },
  { id: 'q3', x: 2, z: -48, riddle: 3, choices: 2 },
  { id: 'q4', x: -2, z: -64, riddle: 4, choices: 3 },
  { id: 'q5', x: 1, z: -80, riddle: 5, choices: 3 }
];

const BRANCHES = [
  {
    id: 'start',
    kind: 'correct',
    points: [
      [0, 0],
      [0.8, -6],
      [-0.5, -11],
      [1.5, -16]
    ]
  },
  {
    id: 'q1-correct',
    kind: 'correct',
    points: [
      [1.5, -16],
      [0.5, -23],
      [-2, -28],
      [-1.5, -32]
    ]
  },
  {
    id: 'q1-decoy',
    kind: 'decoy',
    points: [
      [1.5, -16],
      [6, -18],
      [10, -21],
      [12, -25]
    ]
  },
  {
    id: 'q2-correct',
    kind: 'correct',
    points: [
      [-1.5, -32],
      [-0.5, -39],
      [2.5, -44],
      [2, -48]
    ]
  },
  {
    id: 'q2-decoy',
    kind: 'decoy',
    points: [
      [-1.5, -32],
      [-6, -33],
      [-10, -35],
      [-13, -39]
    ]
  },
  {
    id: 'q3-correct',
    kind: 'correct',
    points: [
      [2, -48],
      [0.5, -55],
      [-2.5, -60],
      [-2, -64]
    ]
  },
  {
    id: 'q3-decoy',
    kind: 'decoy',
    points: [
      [2, -48],
      [7, -50],
      [11, -53],
      [13, -57]
    ]
  },
  {
    id: 'q4-correct',
    kind: 'correct',
    points: [
      [-2, -64],
      [0, -71],
      [-1, -76],
      [1, -80]
    ]
  },
  {
    id: 'q4-east',
    kind: 'decoy',
    points: [
      [-2, -64],
      [3, -65],
      [7, -67],
      [10, -70]
    ]
  },
  {
    id: 'q4-west',
    kind: 'decoy',
    points: [
      [-2, -64],
      [-7, -65],
      [-11, -68],
      [-13, -72]
    ]
  },
  {
    id: 'q5-correct',
    kind: 'correct',
    points: [
      [1, -80],
      [0.5, -85],
      [0, -90],
      [0, -93.5]
    ]
  },
  {
    id: 'q5-west',
    kind: 'decoy',
    points: [
      [1, -80],
      [-4, -82],
      [-7, -85],
      [-9, -89]
    ]
  },
  {
    id: 'q5-east',
    kind: 'decoy',
    points: [
      [1, -80],
      [6, -81],
      [10, -83],
      [13, -86]
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
  if (Math.hypot(x, z) < 4.5) return true;
  if (Math.hypot(x - HOUSE_POINT.x, z - HOUSE_POINT.z) < 8.5) return true;
  return false;
}

for (const branch of PATH_BRANCHES) {
  const isDecoy = branch.kind === 'decoy';
  const steps = [
    { step: 2.4, side: 0, pool: EDGE_TREES, lo: 0.42, hi: 0.68 },
    { step: 3.6, side: 1, pool: PATH_TREES, lo: 0.65, hi: 0.95 },
    { step: 5.4, side: 2, pool: PATH_TREES, lo: 0.85, hi: 1.25 }
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
        const extra = row.side === 0 ? 0.55 : row.side === 1 ? 0.9 : 2.1;
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

// A small grove frames the ceremonial strike rock.
for (let i = 0; i < 8; i++) {
  const a = (i / 8) * Math.PI * 2 + 0.4;
  const r = 5.5 + (i % 3) * 1.6;
  const x = -2.8 + Math.cos(a) * r;
  const z = -1.4 + Math.sin(a) * r;
  const v = PATH_TREES[i % PATH_TREES.length];
  if (Math.hypot(x, z) < 4.2) continue;
  addExtra(v.name, x, z, hash(i, 7, 41) * Math.PI * 2, 0.72 + (i % 4) * 0.14);
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
