/**
 * The opening ceremony.
 *
 * The two hand models are static GLBs; everything here is code animation.
 * On "start", the camera turns to the lone tree-on-rock beside the spawn,
 * the left hand scrapes a match across it, and the match flame is carried to
 * the diya in the right hand. The left hand then lowers out of frame and is
 * removed. The right hand + diya stay as the HUD for the rest of the game.
 *
 * One flame object is shared throughout: it starts hidden, appears at the
 * match tip, travels with the hand, then settles into the diya's wick. While
 * the match is carried over, the right hand tips the diya toward the middle
 * of the frame so the two meet halfway. The shader's wick sits 26% up its
 * quad, so `flame.setWickPosition` handles the offset whenever it is moved.
 *
 * The left forearm points nearly at the lens while the match is held over the
 * diya, which exposes the open elbow end of the mesh. It is fitted with a dark
 * cap so the view cannot pass through the arm into the rock behind it.
 */
import * as THREE from './vendor/three.module.js';
import { GLTFLoader } from './vendor/GLTFLoader.js';

const HAND_DIR = 'models/';
const LEFT_URL = HAND_DIR + 'hand_left.glb';
const RIGHT_URL = HAND_DIR + 'hand_right.glb';

// The right hand's fixed HUD pose, chosen from the pose tuner. The bowl sits
// level with a slight outward turn, holding the diya at the bottom-right of
// the view.
const RIGHT_POSE = {
  position: [0.255, -0.45, -0.225],
  rotation: [0, -0.14, 0.03],
  scale: 0.8
};

// While the match is carried across, the right hand turns the diya toward the
// middle of the frame so the two hands meet halfway instead of the left arm
// doing all the reaching. It returns to RIGHT_POSE once the wick is lit.
const RIGHT_CARRY_POSE = {
  position: [0.345, -0.435, -0.13],
  rotation: [-0.02, 0.24, 0.06],
  scale: 0.8
};

// When the right hand starts and finishes its inward tilt (seconds). It starts
// turning while the match is still recoiling, holds through the transfer, then
// settles back into its resting form and stays still for the closing shot.
const RIGHT_TILT_START = 2.55;
const RIGHT_TILT_END = 4.05;
const RIGHT_HOLD_END = 4.55;
const RIGHT_RETURN_END = 5.05;

// Camera look used for the strike. The rock ray is cast along this direction,
// and the hand is solved to meet that exact point when the camera arrives.
const STRIKE_YAW = 0.83;
const STRIKE_PITCH = -0.25;

// Left-hand strike pose. The GLB is already a left hand, so it must not be
// mirrored: a negative X scale flips the triangle winding and the outside of
// the arm gets culled while the untextured inside shows through.
// Keep these near 1: the model's forearm is a metre long, so a larger scale
// puts the wrist behind the camera and the sleeve covers half the screen.
const STRIKE_ROT = [0.16, -0.7, 0.05];
const STRIKE_SCALE = 0.9;

// Pose used while carrying the match to the diya. The hand stays at the same
// size as the strike so its cut-off forearm end sits behind the lens instead
// of opening into view.
const LIGHT_ROT = [-0.06, -0.34, 0.04];
const LIGHT_SCALE = 0.9;

// The hand enters already rotating toward the stone, then settles into the
// strike grip as it lands. Starting from the grip itself makes the entry read
// like a prop being slid into place.
const APPROACH_ROT = [0.3, -0.5, 0.1];

const FLAME_MATCH_SCALE = 0.5;

// How far in front of the camera the striking hand is allowed to reach. The
// rock sits further out; the arm is kept close so the wrist stays near the
// body and the forearm falls out of the bottom of the frame instead of being
// stretched across the shot. The rock placement is tuned to this reach later.
const MAX_STRIKE_REACH = 0.92;

// Scrape and lift distances, in camera-space metres. The first stroke is short
// and the second one longer; both end with the match lifted clear of the stone
// instead of being dragged backwards along it.
const SCRAPE_DISTANCE = 0.1;
const SCRAPE2_DISTANCE = 0.125;
const RESET_LIFT = 0.05;
const RECOIL_LIFT = 0.09;
const RECOIL_PULL = 0.05;

// The little press onto the wick at the end of the transfer. The withdraw and
// drop start from this same offset so the hand does not pop when it lets go.
const TRANSFER_DIP_Y = -0.012;
const TRANSFER_DIP_Z = 0.006;

// How much of the turn toward the carry grip happens during the recoil, before
// the long arc to the diya starts.
const RECOIL_ROT_BLEND = 0.22;
const RECOIL_SCALE_BLEND = 0.14;

// Timeline (seconds). Kept outside update() so the flame/spot ramps can share
// the same ignition instant. The camera starts back before the hand has quite
// finished its recoil, and the diya begins tipping while the camera is still
// returning, so the three motions overlap instead of ticking over in steps.
const PAN_END = 1.25;
const CONTACT_AT = 1.45;
const SCRAPE1_END = 1.72;
const RESET_END = 1.98;
const SCRAPE2_START = 2.04;
const SCRAPE2_END = 2.38;
const IGNITE_AT = 2.24;
const CARRY_START = 2.62;
const CARRY_END = 4.2;
const TRANSFER_END = 4.55;
const WITHDRAW_END = 4.75;
const DROP_END = 5.4;
const END = 5.85;

const CAMERA_RETURN_START = 2.38;
const CAMERA_RETURN_END = 3.98;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (t) => {
  t = clamp01(t);
  return t * t * (3 - 2 * t);
};
const smoother = (t) => {
  t = clamp01(t);
  return t * t * t * (t * (t * 6 - 15) + 10);
};
const easeIn = (t) => {
  t = clamp01(t);
  return t * t * t;
};

/** Cubic Bezier evaluation into `out`. */
function bezier3(a, b, c, d, t, out) {
  const u = 1 - t;
  const uu = u * u;
  const tt = t * t;
  return out
    .copy(a)
    .multiplyScalar(uu * u)
    .addScaledVector(b, 3 * uu * t)
    .addScaledVector(c, 3 * u * tt)
    .addScaledVector(d, tt * t);
}

/* ------------------------------------------------------------------ */
/*  Loading                                                           */
/* ------------------------------------------------------------------ */
function loadOne(loader, url) {
  return new Promise((resolve, reject) => {
    loader.load(url, resolve, undefined, reject);
  });
}

/**
 * Close the open elbow end of the left forearm.
 *
 * The arm is a single open tube. When the match is held over the diya the
 * forearm points almost straight at the camera, and the open end lets the
 * scene show through as a flat, untextured-looking wedge. The arm renders both
 * faces so its inner wall stays solid, and this dark disc closes the opening
 * so it reads as the shadowed inside of a sleeve.
 */
function capOpenEnd(root) {
  let arm = null;
  let most = 0;
  root.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    const count = o.geometry.attributes.position
      ? o.geometry.attributes.position.count
      : 0;
    if (count > most) {
      most = count;
      arm = o;
    }
  });
  if (!arm) return;

  const geo = arm.geometry;
  const pos = geo.attributes.position;
  const index = geo.index;
  const triangles = index ? index.count / 3 : pos.count / 3;
  const edges = new Map();
  const key = (a, b) => (a < b ? a + ':' + b : b + ':' + a);
  for (let i = 0; i < triangles; i++) {
    const a = index ? index.getX(i * 3) : i * 3;
    const b = index ? index.getX(i * 3 + 1) : i * 3 + 1;
    const c = index ? index.getX(i * 3 + 2) : i * 3 + 2;
    const pairs = [
      [a, b],
      [b, c],
      [c, a]
    ];
    for (const [u, v] of pairs) {
      const k = key(u, v);
      const edge = edges.get(k);
      if (edge) edge.n += 1;
      else edges.set(k, { a: u, b: v, n: 1 });
    }
  }

  // Order the boundary vertices into a ring, then fill that exact outline.
  // A plain ellipse only covers the middle of the opening; at a glancing
  // angle its corners leave slivers of the hollow interior visible.
  const adj = new Map();
  const link = (a, b) => {
    const list = adj.get(a);
    if (list) list.push(b);
    else adj.set(a, [b]);
  };
  let boundaryCount = 0;
  let first = -1;
  for (const edge of edges.values()) {
    if (edge.n !== 1) continue;
    link(edge.a, edge.b);
    link(edge.b, edge.a);
    if (first < 0) first = edge.a;
    boundaryCount++;
  }
  if (boundaryCount < 8) return;

  const ring = [first];
  let prev = -1;
  let cur = first;
  let closed = false;
  for (let i = 0; i < boundaryCount; i++) {
    const nbrs = adj.get(cur);
    if (!nbrs || nbrs.length !== 2) break;
    const next = nbrs[0] === prev ? nbrs[1] : nbrs[0];
    if (next === first) {
      closed = true;
      break;
    }
    ring.push(next);
    prev = cur;
    cur = next;
  }
  if (!closed || ring.length !== boundaryCount) return;

  const p = new THREE.Vector3();
  const center = new THREE.Vector3();
  for (const i of ring) {
    p.fromBufferAttribute(pos, i);
    center.add(p);
  }
  center.multiplyScalar(1 / ring.length);
  center.z -= 0.002;

  const verts = [center.x, center.y, center.z];
  for (const i of ring) {
    p.fromBufferAttribute(pos, i);
    verts.push(p.x, p.y, p.z);
  }
  const faces = [];
  for (let i = 0; i < ring.length; i++) {
    faces.push(0, 1 + i, 1 + ((i + 1) % ring.length));
  }

  const capGeo = new THREE.BufferGeometry();
  capGeo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  capGeo.setIndex(faces);
  capGeo.computeVertexNormals();

  const cap = new THREE.Mesh(
    capGeo,
    new THREE.MeshStandardMaterial({
      color: 0x120905,
      roughness: 1,
      metalness: 0,
      side: THREE.DoubleSide
    })
  );
  cap.name = 'left_forearm_cap';
  cap.frustumCulled = false;
  arm.add(cap);
}

function prepare(root, isLeft) {
  root.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = false;
    o.receiveShadow = false;
    // Attached to the camera and never culled by a stale bounding sphere.
    o.frustumCulled = false;

    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (!m) continue;
      // The left forearm is an open tube that is often seen from the inside
      // while the match is carried, so it must render both faces or the room
      // shows through it. The dark elbow cap closes the cut end. The right
      // hand never faces that way, so it stays front-sided.
      m.side = isLeft ? THREE.DoubleSide : THREE.FrontSide;
      if (m.metalness !== undefined) m.metalness = 0;
      if (m.roughness !== undefined) m.roughness = Math.min(m.roughness, 0.82);
      if (m.emissive) {
        // A faint warm fill keeps the hands readable in a pitch-black forest
        // without adding a second light to the world.
        m.emissive.setHex(0x2a1409);
        m.emissiveIntensity = isLeft ? 0.5 : 0.42;
      }
      m.needsUpdate = true;
    }
  });
}

export function loadHands() {
  const loader = new GLTFLoader();
  return Promise.all([loadOne(loader, LEFT_URL), loadOne(loader, RIGHT_URL)])
    .then(([left, right]) => {
      prepare(left.scene, true);
      prepare(right.scene, false);
      capOpenEnd(left.scene);
      return { left: left.scene, right: right.scene };
    })
    .catch((err) => {
      console.warn('[hands] could not load hand models:', err && err.message);
      return null;
    });
}

/* ------------------------------------------------------------------ */
/*  Intro                                                             */
/* ------------------------------------------------------------------ */
export function createIntro({ camera, flame, spot, hands, environment, setView, onDone }) {
  const { left, right } = hands;

  const matchTip = left.getObjectByName('match_tip');
  const diyaWick = right.getObjectByName('diya_wick');
  if (!matchTip || !diyaWick) {
    console.warn('[intro] hand rig is missing match_tip or diya_wick');
    return null;
  }

  // Right hand: the diya HUD pose.
  applyRightPose(RIGHT_POSE);
  camera.add(right);

  // Wick in camera space. Everything about the flame hangs off this point.
  const wickLocal = new THREE.Vector3();
  wickInCamera(wickLocal);

  // Left hand starts just below the frame.
  left.visible = false;
  left.scale.setScalar(STRIKE_SCALE);
  camera.add(left);

  // A small warm point light, motivated by the flame, lights the hands and
  // the near side of the rock. It follows the flame during the ceremony and
  // remains at the diya wick for gameplay.
  const handLight = new THREE.PointLight(0xff9a3c, 0, 3.2, 2);
  handLight.position.copy(wickLocal).add(new THREE.Vector3(0, 0.1, 0));
  camera.add(handLight);

  // The diya is unlit while the menu is up.
  flame.setVisible(false);
  spot.intensity = 0;

  const rock =
    environment && environment.meshes
      ? environment.meshes.find((m) => m.name && m.name.startsWith('Tree_On_Rock'))
      : null;

  const raycaster = new THREE.Raycaster();
  const strikeWorld = new THREE.Vector3(-1.32, 1.14, -1.21);
  const strikeLocal = new THREE.Vector3();
  const strikeTip = new THREE.Vector3();
  const strikePos = new THREE.Vector3();
  const offPos = new THREE.Vector3();
  const riseC1 = new THREE.Vector3();
  const riseC2 = new THREE.Vector3();
  const lightPos = new THREE.Vector3();
  const wickNow = new THREE.Vector3();
  const carryTarget = new THREE.Vector3();
  const carryStartTip = new THREE.Vector3();
  const tipTarget = new THREE.Vector3();
  const tipA = new THREE.Vector3();
  const tipB = new THREE.Vector3();
  const tangentLocal = new THREE.Vector3(1, 0, 0);
  const scratch = new THREE.Vector3();
  // solveLeftClean overwrites this while measuring the tip, so it must never
  // be the same vector callers pass in as the desired target.
  const solveScratch = new THREE.Vector3();

  let started = false;
  let finished = false;
  let time = 0;
  let lit = false;
  let flare = 1;
  let leftDropped = false;
  let paused = false;

  /* ---- Solve the left hand so its match tip lands on `targetLocal`. ---- */
  function solveLeftClean(targetLocal, rot, scale) {
    left.position.set(0, 0, 0);
    left.rotation.set(rot[0], rot[1], rot[2]);
    left.scale.setScalar(scale);
    left.updateMatrixWorld(true);
    matchTip.getWorldPosition(solveScratch);
    camera.worldToLocal(solveScratch);
    left.position.add(targetLocal).sub(solveScratch);
    left.updateMatrixWorld(true);
  }

  /* ---- Right hand poses -------------------------------------------- */
  function applyRightPose(pose) {
    right.position.fromArray(pose.position);
    right.rotation.set(pose.rotation[0], pose.rotation[1], pose.rotation[2]);
    right.scale.setScalar(pose.scale);
    right.updateMatrixWorld(true);
  }

  /** How far the diya is tipped toward the middle of the shot, 0..1. */
  function rightTilt(time) {
    if (time < RIGHT_TILT_START) return 0;
    if (time < RIGHT_TILT_END) {
      return smoother((time - RIGHT_TILT_START) / (RIGHT_TILT_END - RIGHT_TILT_START));
    }
    if (time < RIGHT_HOLD_END) return 1;
    if (time < RIGHT_RETURN_END) {
      return 1 - smoother((time - RIGHT_HOLD_END) / (RIGHT_RETURN_END - RIGHT_HOLD_END));
    }
    return 0;
  }

  function poseRight(time) {
    const k = rightTilt(time);
    const a = RIGHT_POSE;
    const b = RIGHT_CARRY_POSE;
    right.position.set(
      lerp(a.position[0], b.position[0], k),
      lerp(a.position[1], b.position[1], k),
      lerp(a.position[2], b.position[2], k)
    );
    right.rotation.set(
      lerp(a.rotation[0], b.rotation[0], k),
      lerp(a.rotation[1], b.rotation[1], k),
      lerp(a.rotation[2], b.rotation[2], k)
    );
    right.scale.setScalar(lerp(a.scale, b.scale, k));
    right.updateMatrixWorld(true);
  }

  /** The diya wick in camera space for the current right-hand pose. */
  function wickInCamera(out) {
    diyaWick.getWorldPosition(out);
    camera.worldToLocal(out);
    return out;
  }

  /** Find the exact rock face the camera will look at. */
  function findStrike() {
    if (!rock) return;
    rock.updateMatrixWorld(true);
    const dir = new THREE.Vector3(
      -Math.sin(STRIKE_YAW) * Math.cos(STRIKE_PITCH),
      Math.sin(STRIKE_PITCH),
      -Math.cos(STRIKE_YAW) * Math.cos(STRIKE_PITCH)
    ).normalize();
    raycaster.set(camera.position, dir);
    const hits = raycaster.intersectObject(rock, false);
    if (hits.length) {
      strikeWorld.copy(hits[0].point);

      // Pull the strike point toward the camera along the same ray. The hand
      // stays near the body; the rock is moved to meet it later.
      if (strikeWorld.distanceTo(camera.position) > MAX_STRIKE_REACH) {
        strikeWorld
          .sub(camera.position)
          .setLength(MAX_STRIKE_REACH)
          .add(camera.position);
      }

      // Scrape direction: downhill along the face the match touches.
      const face = hits[0].face;
      if (face) {
        const instance = new THREE.Matrix4();
        rock.getMatrixAt(0, instance);
        const world = new THREE.Matrix4().multiplyMatrices(rock.matrixWorld, instance);
        const n = face.normal
          .clone()
          .applyMatrix3(new THREE.Matrix3().getNormalMatrix(world))
          .normalize();
        const down = new THREE.Vector3(0, -1, 0);
        const tangent = down.addScaledVector(n, -down.dot(n));
        if (tangent.lengthSq() > 1e-5) tangent.normalize();
        else tangent.set(1, 0, 0);

        const a = camera.worldToLocal(strikeWorld.clone());
        const b = camera.worldToLocal(strikeWorld.clone().add(tangent));
        tangentLocal.copy(b).sub(a).normalize();
      }
    }
  }

  function start() {
    if (started) return;
    started = true;
    time = 0;

    // Put the camera at the strike view just long enough to solve the hand
    // against the real rock point, then snap back to the menu view.
    setView(STRIKE_YAW, STRIKE_PITCH);
    camera.updateMatrixWorld(true);
    findStrike();
    strikeLocal.copy(strikeWorld);
    camera.worldToLocal(strikeLocal);

    strikeTip.copy(strikeLocal);
    solveLeftClean(strikeTip, STRIKE_ROT, STRIKE_SCALE);
    strikePos.copy(left.position);

    // The carry begins where the recoil leaves the match: just off the stone,
    // a little backwards along the scrape, and lifted clear of the face.
    carryStartTip.copy(strikeTip).addScaledVector(tangentLocal, 0.02);
    carryStartTip.y += RECOIL_LIFT;
    carryStartTip.z += RECOIL_PULL;

    // The hand rises from below the frame in a shallow arc rather than on a
    // straight line, then settles onto the stone as the camera arrives.
    offPos.copy(strikePos).add(new THREE.Vector3(0.02, -1.15, 0.22));
    riseC1.copy(offPos).add(new THREE.Vector3(0.14, 0.55, 0.1));
    riseC2.copy(strikePos).add(new THREE.Vector3(0.18, 0.18, 0.16));

    // The match arrives while the right hand is tipped inward, so solve the
    // carry pose against the wick where it will actually be.
    applyRightPose(RIGHT_CARRY_POSE);
    wickInCamera(wickNow);
    carryTarget.set(wickNow.x, wickNow.y + 0.065, wickNow.z + 0.015);
    solveLeftClean(carryTarget, LIGHT_ROT, LIGHT_SCALE);
    lightPos.copy(left.position);

    // Back to the HUD pose for the first frame of the pan.
    applyRightPose(RIGHT_POSE);
    wickInCamera(wickNow);

    // Reset for the first frame of the pan.
    left.position.copy(offPos);
    left.rotation.set(...STRIKE_ROT);
    left.scale.setScalar(STRIKE_SCALE);
    left.visible = true;
    left.updateMatrixWorld(true);

    setView(0, 0);
    camera.updateMatrixWorld(true);
    flame.setVisible(false);
    spot.intensity = 0;
    handLight.intensity = 0;
  }

  function ignite() {
    if (lit) return;
    lit = true;
    flare = 2.1;
    flame.setVisible(true);
  }

  function dropLeft() {
    if (leftDropped) return;
    leftDropped = true;
    left.visible = false;
    camera.remove(left);
    left.traverse((o) => {
      if (!o.isMesh) return;
      if (o.geometry) o.geometry.dispose();
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) if (m) m.dispose();
    });
  }

  function finish() {
    if (finished) return;
    finished = true;
    left.visible = false;
    dropLeft();

    // Hand the diya back at its resting pose before pinning the flame.
    applyRightPose(RIGHT_POSE);
    wickInCamera(wickLocal);

    flame.setVisible(true);
    flame.setWickPosition(wickLocal.x, wickLocal.y, wickLocal.z, 1);
    handLight.position.copy(wickLocal);
    handLight.position.y += 0.08;
    handLight.intensity = 3.2;
    spot.intensity = 40;
    flare = 1;
    setView(0, 0);
    if (onDone) onDone();
  }

  /** The match tip in camera space. */
  function tipLocal(out) {
    matchTip.getWorldPosition(out);
    camera.worldToLocal(out);
    return out;
  }

  function update(dt) {
    if (!started || finished || paused) return;
    const d = Math.min(dt || 0, 0.1);
    time += d;

    // Timeline (seconds)
    //   0.00-1.25  camera turns to the rock while the hand rises in an arc
    //   1.25-1.45  hand settles onto the stone
    //   1.45-1.72  first scrape
    //   1.72-1.98  match lifts and swings back over the stone
    //   1.98-2.38  second, longer scrape; the match catches on the way
    //   2.38-2.62  recoil: match lifts clear as the wrist starts to turn
    //   2.38-3.98  camera returns while the diya tips inward
    //   2.62-4.20  match carried to the diya on an arc
    //   4.20-4.55  flame passes to the wick
    //   4.55-4.75  hand pulls away from the lamp
    //   4.75-5.40  left hand falls out of frame
    //   4.55-5.05  diya settles back to its resting pose and holds still
    //   5.85       gameplay

    // ---- camera ----
    let yaw = 0;
    let pitch = 0;
    if (time < PAN_END) {
      const e = smoother(time / PAN_END);
      yaw = STRIKE_YAW * e;
      pitch = STRIKE_PITCH * e;
    } else if (time < CAMERA_RETURN_START) {
      yaw = STRIKE_YAW;
      pitch = STRIKE_PITCH;
    } else if (time < CAMERA_RETURN_END) {
      const e = smoother(
        (time - CAMERA_RETURN_START) / (CAMERA_RETURN_END - CAMERA_RETURN_START)
      );
      yaw = STRIKE_YAW * (1 - e);
      pitch = STRIKE_PITCH * (1 - e);
    } else {
      yaw = 0;
      pitch = 0;
    }

    // A little hand-held drift keeps the held shot from looking locked off.
    const sway =
      0.0016 * Math.sin(time * 1.7 + 0.4) +
      0.0011 * Math.sin(time * 2.9 + 1.7);
    yaw += sway;
    pitch += sway * 0.6;

    // The match shivers against the stone; ignition adds a short kick.
    if (time > CONTACT_AT && time < SCRAPE2_END) {
      const k = 0.0024 * Math.sin(time * 54) * Math.sin(time * 37 + 1.1);
      yaw += k;
      pitch += k * 0.6;
    }
    if (time > IGNITE_AT) {
      const kick = Math.exp(-(time - IGNITE_AT) * 7.5);
      yaw += 0.0045 * kick * Math.sin((time - IGNITE_AT) * 46);
      pitch += 0.003 * kick * Math.sin((time - IGNITE_AT) * 38 + 0.7);
    }
    setView(yaw, pitch);
    camera.updateMatrixWorld(true);

    // The right hand brings the diya toward the middle of the frame while the
    // match travels over, then returns to its resting HUD pose.
    poseRight(time);
    wickInCamera(wickNow);
    carryTarget.set(wickNow.x, wickNow.y + 0.065, wickNow.z + 0.015);

    const recoilRot0 = lerp(STRIKE_ROT[0], LIGHT_ROT[0], RECOIL_ROT_BLEND);
    const recoilRot1 = lerp(STRIKE_ROT[1], LIGHT_ROT[1], RECOIL_ROT_BLEND);
    const recoilRot2 = lerp(STRIKE_ROT[2], LIGHT_ROT[2], RECOIL_ROT_BLEND);
    const recoilScale = lerp(STRIKE_SCALE, LIGHT_SCALE, RECOIL_SCALE_BLEND);

    // ---- hand path ----
    if (time < CONTACT_AT) {
      // Rise and settle in one arc, already turning into the strike grip.
      const u = smoother((time - 0.04) / (CONTACT_AT - 0.04));
      bezier3(offPos, riseC1, riseC2, strikePos, u, left.position);
      left.rotation.set(
        lerp(APPROACH_ROT[0], STRIKE_ROT[0], u),
        lerp(APPROACH_ROT[1], STRIKE_ROT[1], u),
        lerp(APPROACH_ROT[2], STRIKE_ROT[2], u)
      );
      left.scale.setScalar(STRIKE_SCALE);
    } else if (time < RESET_END) {
      // First stroke: drag along the stone, then lift and swing back above it
      // rather than retracing the same line backwards.
      let d;
      let lift;
      let pull;
      let roll;
      if (time < SCRAPE1_END) {
        const u = smoother((time - CONTACT_AT) / (SCRAPE1_END - CONTACT_AT));
        d = SCRAPE_DISTANCE * u;
        lift = 0;
        pull = 0;
        roll = 0.04 * u;
      } else {
        const u = smoother((time - SCRAPE1_END) / (RESET_END - SCRAPE1_END));
        d = SCRAPE_DISTANCE * (1 - u);
        lift = RESET_LIFT * Math.sin(Math.PI * u);
        pull = 0.018 * Math.sin(Math.PI * u);
        roll = 0.04 * (1 - u);
      }
      tipTarget.copy(strikeTip).addScaledVector(tangentLocal, d);
      tipTarget.y += lift;
      tipTarget.z += pull;
      solveLeftClean(
        tipTarget,
        [STRIKE_ROT[0], STRIKE_ROT[1], STRIKE_ROT[2] + roll],
        STRIKE_SCALE
      );
    } else if (time < CARRY_START) {
      // Second stroke. It starts slowly, accelerates as the match bites, then
      // lifts away; the wrist begins its turn before the long carry starts.
      let d;
      let lift;
      let pull;
      let roll;
      let rotBlend;
      if (time < SCRAPE2_END) {
        const u = easeIn((time - SCRAPE2_START) / (SCRAPE2_END - SCRAPE2_START));
        d = SCRAPE2_DISTANCE * u;
        lift = 0;
        pull = 0;
        roll = -0.03 * u;
        rotBlend = 0;
        if (time > IGNITE_AT) ignite();
      } else {
        const u = smoother((time - SCRAPE2_END) / (CARRY_START - SCRAPE2_END));
        d = lerp(SCRAPE2_DISTANCE, 0.02, u);
        lift = RECOIL_LIFT * u;
        pull = RECOIL_PULL * u;
        roll = -0.03 * (1 - u);
        rotBlend = u;
      }
      tipTarget.copy(strikeTip).addScaledVector(tangentLocal, d);
      tipTarget.y += lift;
      tipTarget.z += pull;
      solveLeftClean(
        tipTarget,
        [
          lerp(STRIKE_ROT[0], recoilRot0, rotBlend),
          lerp(STRIKE_ROT[1], recoilRot1, rotBlend),
          lerp(STRIKE_ROT[2], recoilRot2, rotBlend) + roll
        ],
        lerp(STRIKE_SCALE, recoilScale, rotBlend)
      );
    } else if (time < CARRY_END) {
      // Carry on a lifted arc. The wrist turns a touch behind the arm so the
      // hand does not move like one rigid piece.
      const u = smoother((time - CARRY_START) / (CARRY_END - CARRY_START));
      tipA.copy(carryStartTip);
      tipA.x += 0.12;
      tipA.y += 0.1;
      tipA.z += 0.04;
      tipB.copy(carryTarget);
      tipB.x -= 0.18;
      tipB.y += 0.18;
      tipB.z += 0.1;
      bezier3(carryStartTip, tipA, tipB, carryTarget, u, tipTarget);
      tipTarget.x += Math.sin(Math.PI * u) * 0.012;
      const ru = smoother(
        (time - CARRY_START - 0.06) / (CARRY_END - CARRY_START - 0.06)
      );
      solveLeftClean(
        tipTarget,
        [
          lerp(recoilRot0, LIGHT_ROT[0], ru),
          lerp(recoilRot1, LIGHT_ROT[1], ru),
          lerp(recoilRot2, LIGHT_ROT[2], ru) +
            Math.sin(Math.PI * ru) * 0.045
        ],
        lerp(recoilScale, LIGHT_SCALE, ru)
      );
    } else if (time < TRANSFER_END) {
      // Hold the match at the wick. A small press and a breath of drift keep
      // the hand alive while the flame settles into the diya.
      const u = smoother((time - CARRY_END) / (TRANSFER_END - CARRY_END));
      tipTarget.copy(carryTarget);
      tipTarget.y += TRANSFER_DIP_Y * u;
      tipTarget.z += TRANSFER_DIP_Z * u;
      tipTarget.x += 0.0022 * Math.sin(time * 6.1);
      tipTarget.y += 0.0015 * Math.sin(time * 4.7 + 0.9);
      solveLeftClean(
        tipTarget,
        [
          LIGHT_ROT[0] + 0.004 * Math.sin(time * 4.2),
          LIGHT_ROT[1],
          LIGHT_ROT[2] + 0.006 * Math.sin(time * 3.6 + 0.3)
        ],
        LIGHT_SCALE
      );
      // The withdraw and drop start from exactly where the hand let go.
      lightPos.copy(left.position);
    } else if (time < WITHDRAW_END) {
      // Ease the match back out of the lamp before the arm falls.
      const u = smoother((time - TRANSFER_END) / (WITHDRAW_END - TRANSFER_END));
      left.position.copy(lightPos);
      left.position.x -= 0.1 * u;
      left.position.y += 0.038 * u;
      left.position.z += 0.056 * u;
      left.rotation.set(
        LIGHT_ROT[0] - 0.12 * u,
        LIGHT_ROT[1] - 0.04 * u,
        LIGHT_ROT[2] + 0.1 * u
      );
    } else if (time < DROP_END) {
      // Let the arm fall under gravity, turning as it goes so the open end of
      // the forearm is carried out of the bottom corner.
      const u = clamp01((time - WITHDRAW_END) / (DROP_END - WITHDRAW_END));
      const e = u * u * (1.1 + 0.9 * u);
      left.position.copy(lightPos);
      left.position.x += -0.1 - 0.78 * e;
      left.position.y += 0.038 - 1.55 * e;
      left.position.z += 0.056 + 0.14 * e;
      left.rotation.set(
        LIGHT_ROT[0] - 0.12 - 0.33 * e,
        LIGHT_ROT[1] - 0.04 - 0.16 * e,
        LIGHT_ROT[2] + 0.1 + 0.45 * e
      );
    } else {
      dropLeft();
    }

    left.updateMatrixWorld(true);

    // ---- flame ----
    if (lit) {
      const tip = tipLocal(scratch);
      if (time < CARRY_END) {
        flame.setWickPosition(tip.x, tip.y, tip.z, FLAME_MATCH_SCALE);
        handLight.position.copy(tip);
        handLight.position.y += 0.04;
        handLight.intensity = 2.4 + 0.6 * Math.sin(time * 9);

        // The match is a candle now: let the world light come up gently from
        // the moment it catches, so the rock face is revealed and the camera
        // pan back is lit from the hand rather than from nowhere.
        spot.intensity = 16 * smooth((time - IGNITE_AT) / 1.1);
      } else if (time < TRANSFER_END) {
        const e = smoother((time - CARRY_END) / (TRANSFER_END - CARRY_END));
        const x = lerp(tip.x, wickNow.x, e);
        const y = lerp(tip.y, wickNow.y, e);
        const z = lerp(tip.z, wickNow.z, e);
        const s = lerp(FLAME_MATCH_SCALE, 1, e);
        flame.setWickPosition(x, y, z, s);
        handLight.position.set(x, y + 0.08, z);
        handLight.intensity = lerp(3.0, 4.2, e);
        spot.intensity = lerp(16, 40, e);
      } else {
        // The right hand may still be settling back; the flame rides the wick.
        flame.setWickPosition(wickNow.x, wickNow.y, wickNow.z, 1);
        handLight.position.copy(wickNow);
        handLight.position.y += 0.08;
        handLight.intensity = 4.2;
        spot.intensity = 40;
      }

      // Brief, tasteful flare when the match catches. Main applies this after
      // flame.update so the per-frame flicker does not overwrite it.
      flare += (1 - flare) * (1 - Math.exp(-4.5 * d));
    } else {
      spot.intensity = 0;
    }

    if (time >= END) finish();
  }

  return {
    start,
    update,

    // Debug helpers used by the pose-tuning harness. Freezing the ceremony
    // and jumping to an exact second makes screenshots repeatable even on a
    // slow software renderer.
    pause(v) {
      paused = !!v;
    },
    seek(t) {
      if (!started || finished) return;
      const wasPaused = paused;
      paused = false;
      const target = Math.max(0, Math.min(t, END));
      if (target > IGNITE_AT) ignite();
      time = target;
      update(0);
      paused = wasPaused;
    },

    rightHand: right,
    leftHand: left,
    wickLocal,
    handLight,
    strikeWorld,
    get started() {
      return started;
    },
    get finished() {
      return finished;
    },
    get lit() {
      return lit;
    },
    get time() {
      return time;
    },
    get flameBoost() {
      return lit ? flare : 1;
    },
    get leftVisible() {
      return !leftDropped && left.visible && !!left.parent;
    }
  };
}
