/**
 * The riddle path network.
 *
 * Five decisions lead from the spawn to the house. The first three give two
 * choices, the last two give three. Every decoy curves out of sight and ends
 * under a blocked log, so the dead end is not readable from the fork.
 *
 * This module owns the path geometry, a cheap nearest-path lookup used by the
 * terrain and the environment, and the extra trees/logs that line and block
 * the branches. Riddle content is deliberately not here yet.
 */
import * as THREE from './vendor/three.module.js';

export const PATH_HALF_WIDTH = 1.35;
export const PATH_FLAT_RADIUS = 3.1;

const SAMPLE_STEP = 0.6;
const CELL = 4;

/* ------------------------------------------------------------------ */
/*  Decisions + branches                                              */
/* ------------------------------------------------------------------ */
export const PATH_DECISIONS = [
  { id: 'q1', x: 4.5, z: 4.5, riddle: 1, choices: 2 },
  { id: 'q2', x: 8.8, z: 9.2, riddle: 2, choices: 2 },
  { id: 'q3', x: 13.5, z: 12.8, riddle: 3, choices: 2 },
  { id: 'q4', x: 18, z: 17.2, riddle: 4, choices: 3 },
  { id: 'q5', x: 22, z: 21, riddle: 5, choices: 3 }
];
export const HOUSE_POINT = { x: 25, z: 25 };

const BRANCHES = [
  // The trail is a mostly straight diagonal from spawn to the house, with
  // just enough curve at each decision to hide the dead ends.
  {
    id: 'start',
    kind: 'correct',
    points: [
      [0, 0],
      [1.5, 1.5],
      [3, 3],
      [4.5, 4.5]
    ]
  },
  {
    id: 'q1-correct',
    kind: 'correct',
    points: [
      [4.5, 4.5],
      [6.5, 6.2],
      [7.8, 8.0],
      [8.8, 9.2]
    ]
  },
  {
    id: 'q1-decoy',
    kind: 'decoy',
    points: [
      [4.5, 4.5],
      [2.5, 6.5],
      [1.0, 9.0],
      [-0.5, 12.0]
    ]
  },
  {
    id: 'q2-correct',
    kind: 'correct',
    points: [
      [8.8, 9.2],
      [10.5, 10.2],
      [12.0, 11.5],
      [13.5, 12.8]
    ]
  },
  {
    id: 'q2-decoy',
    kind: 'decoy',
    points: [
      [8.8, 9.2],
      [11.5, 7.5],
      [14.0, 5.5],
      [16.0, 3.5]
    ]
  },
  {
    id: 'q3-correct',
    kind: 'correct',
    points: [
      [13.5, 12.8],
      [15.0, 14.3],
      [16.5, 15.8],
      [18.0, 17.2]
    ]
  },
  {
    id: 'q3-decoy',
    kind: 'decoy',
    points: [
      [13.5, 12.8],
      [11.0, 14.5],
      [9.0, 16.5],
      [7.5, 19.0]
    ]
  },
  {
    id: 'q4-correct',
    kind: 'correct',
    points: [
      [18.0, 17.2],
      [19.5, 18.5],
      [21.0, 19.8],
      [22.0, 21.0]
    ]
  },
  {
    id: 'q4-east',
    kind: 'decoy',
    points: [
      [18.0, 17.2],
      [21.0, 16.0],
      [24.0, 14.5],
      [26.5, 13.0]
    ]
  },
  {
    id: 'q4-west',
    kind: 'decoy',
    points: [
      [18.0, 17.2],
      [15.5, 19.0],
      [13.0, 21.0],
      [11.5, 23.5]
    ]
  },
  {
    id: 'q5-correct',
    kind: 'correct',
    points: [
      [22.0, 21.0],
      [23.0, 22.5],
      [24.0, 23.5],
      [25.0, 25.0]
    ]
  },
  {
    id: 'q5-west',
    kind: 'decoy',
    points: [
      [22.0, 21.0],
      [19.0, 22.5],
      [16.0, 24.0],
      [14.0, 26.5]
    ]
  },
  {
    id: 'q5-east',
    kind: 'decoy',
    points: [
      [22.0, 21.0],
      [25.0, 22.0],
      [28.0, 23.0],
      [30.0, 25.0]
    ]
  }
];

/* ------------------------------------------------------------------ */
/*  Sample the splines                                                */
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

// Give each decision its outgoing options for the future riddle UI.
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

/**
 * Distance to the nearest sample of any path branch. Sample spacing is
 * 0.6 m, so the result is accurate enough for terrain masks and clearances.
 */
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
/*  Path-side trees and blockers                                      */
/* ------------------------------------------------------------------ */
const TREE_VARIANTS = [
  { name: 'Tree_Small_1', radius: 2.04 },
  { name: 'Tree_Small_2', radius: 3.41 },
  { name: 'Tree_Bare_1', radius: 2.02 },
  { name: 'Tree_Bare_2', radius: 3.41 },
  { name: 'Tree_Large_1', radius: 2.11 },
  { name: 'Tree_Large_2', radius: 2.47 },
  { name: 'Tree_Stump', radius: 0.64 }
];

function hash(a, b, c) {
  let h = a * 374761393 + b * 668265263 + c * 1442695041;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

/** Extra instances merged into the forest, keyed by model name. */
export const PATH_EXTRAS = Object.create(null);
const addExtra = (name, x, z, rot, scale) => {
  const list = PATH_EXTRAS[name] || (PATH_EXTRAS[name] = []);
  list.push({ x, z, rot, scale });
};

for (const branch of PATH_BRANCHES) {
  // Leave the fork mouth open and do not crowd the spawn, house, or blockers.
  const isDecoy = branch.kind === 'decoy';
  const step = Math.max(1, Math.round(5.2 / SAMPLE_STEP));

  for (let i = step; i < branch.samples.length - 2; i += step) {
    const s = branch.samples[i];
    const prev = branch.samples[i - 1];
    const next = branch.samples[i + 1];
    let dx = next.x - prev.x;
    let dz = next.z - prev.z;
    const len = Math.hypot(dx, dz) || 1;
    dx /= len;
    dz /= len;

    if (Math.hypot(s.x, s.z) < 7) continue;
    if (Math.hypot(s.x - HOUSE_POINT.x, s.z - HOUSE_POINT.z) < 7) continue;
    if (isDecoy && i > branch.samples.length - 8) continue;
    const node = nearestDecision(s.x, s.z, 5);
    if (node) continue;

    for (const side of [-1, 1]) {
      const h = hash(i, side, branch.id.length * 97);
      if (h > 0.62) continue;

      const variant = TREE_VARIANTS[(i + (side > 0 ? 3 : 0)) % TREE_VARIANTS.length];
      const scale = 0.82 + hash(i, side, 311) * 0.28;
      const offset = variant.radius * scale + PATH_HALF_WIDTH + 0.9;
      const nx = s.x - dz * side * offset;
      const nz = s.z + dx * side * offset;

      // A second branch may pass closer than this one; keep that one clear.
      const other = nearestPath(nx, nz, offset + 4);
      if (other && other.dist < offset - 0.3) continue;

      addExtra(
        variant.name,
        nx,
        nz,
        hash(i, side, 733) * Math.PI * 2,
        scale
      );
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Inner corridor wall                                                */
/* ------------------------------------------------------------------ */
const INNER_TREES = [
  { name: 'Tree_Small_1', radius: 2.04 },
  { name: 'Tree_Bare_1', radius: 2.02 },
  { name: 'Tree_Small_2', radius: 3.41 },
  { name: 'Tree_Bare_2', radius: 3.41 }
];

for (const branch of PATH_BRANCHES) {
  const isDecoy = branch.kind === 'decoy';
  const step = Math.max(1, Math.round(3.4 / SAMPLE_STEP));

  for (let i = step; i < branch.samples.length - 2; i += step) {
    const s = branch.samples[i];
    const prev = branch.samples[i - 1];
    const next = branch.samples[i + 1];
    let dx = next.x - prev.x;
    let dz = next.z - prev.z;
    const len = Math.hypot(dx, dz) || 1;
    dx /= len;
    dz /= len;

    if (Math.hypot(s.x, s.z) < 5) continue;
    if (Math.hypot(s.x - HOUSE_POINT.x, s.z - HOUSE_POINT.z) < 6) continue;
    if (isDecoy && i > branch.samples.length - 6) continue;
    if (nearestDecision(s.x, s.z, 4.5)) continue;

    for (const side of [-1, 1]) {
      if (hash(i, side, 181) > 0.82) continue;
      const variant = INNER_TREES[(i + (side > 0 ? 1 : 0)) % INNER_TREES.length];
      const scale = 0.62 + hash(i, side, 419) * 0.16;
      const offset = variant.radius * scale + PATH_HALF_WIDTH + 0.65;
      const nx = s.x - dz * side * offset;
      const nz = s.z + dx * side * offset;

      const other = nearestPath(nx, nz, offset + 3);
      if (other && other.dist < offset - 0.25) continue;

      addExtra(
        variant.name,
        nx,
        nz,
        hash(i, side, 887) * Math.PI * 2,
        scale
      );
    }
  }
}

// Blockers: a fallen log across each decoy, with trees and a rock behind it.
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

  // Tree_Fallen's long axis is local Z; this lays it across the trail.
  addExtra('Tree_Fallen', end.x, end.z, across, 1.0);
  addExtra(
    'Tree_Large_1',
    end.x + dx * 2.6 + px * 0.9,
    end.z + dz * 2.6 + pz * 0.9,
    hash(end.x, end.z, 1) * Math.PI * 2,
    1.0
  );
  addExtra(
    'Tree_Small_2',
    end.x + dx * 2.2 - px * 1.15,
    end.z + dz * 2.2 - pz * 1.15,
    hash(end.x, end.z, 2) * Math.PI * 2,
    0.92
  );
  addExtra(
    'Rock_Medium',
    end.x + dx * 1.5 + px * 1.9,
    end.z + dz * 1.5 + pz * 1.9,
    hash(end.x, end.z, 3) * Math.PI * 2,
    0.78
  );
}

/** Exposed for later riddle placement and debug views. */
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
