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
 * match tip, travels with the hand, then settles into the diya's wick. The
 * shader's wick sits 26% up its quad, so `flame.setWickPosition` handles the
 * offset whenever the flame is moved.
 */
import * as THREE from './vendor/three.module.js';
import { GLTFLoader } from './vendor/GLTFLoader.js';

const HAND_DIR = 'models/';
const LEFT_URL = HAND_DIR + 'hand_left.glb';
const RIGHT_URL = HAND_DIR + 'hand_right.glb';

// The right hand's fixed HUD pose. These values put the diya wick at roughly
// (0.45, -0.42, -1.0) in camera space, which is the same bottom-right spot
// the standalone flame used to occupy.
const RIGHT_POSE = {
  position: [0.43, -0.45, -0.13],
  rotation: [-0.15, 0, 0],
  scale: 0.8
};

// Camera look used for the strike. The rock ray is cast along this direction,
// and the hand is solved to meet that exact point when the camera arrives.
const STRIKE_YAW = 0.83;
const STRIKE_PITCH = -0.25;

// Left-hand strike pose. Mirrored on X so the arm enters from the lower left.
// Keep these near 1: the model's forearm is a metre long, so a larger scale
// puts the wrist behind the camera and the sleeve covers half the screen.
const STRIKE_ROT = [0.16, -0.7, 0.05];
const STRIKE_SCALE = 0.9;

// Pose used while carrying the match to the diya.
const LIGHT_ROT = [-0.06, -0.34, 0.04];
const LIGHT_SCALE = 0.72;

const FLAME_MATCH_SCALE = 0.5;

// Where the match sits relative to the strike point just after ignition, and
// a couple of reusable offsets so the per-frame timeline allocates nothing.
const PULLBACK = new THREE.Vector3(0.01, 0.05, 0.11);
const SCRAPE_DISTANCE = 0.07;

// Timeline (seconds). Kept outside update() so the flame/spot ramps can share
// the same ignition instant.
const PAN_END = 1.25;
const APPROACH_END = 1.55;
const SCRAPE1_END = 1.85;
const SCRAPE2_END = 2.3;
const IGNITE_AT = SCRAPE1_END + 0.16;
const CARRY_START = 2.8;
const CARRY_END = 4.3;
const TRANSFER_END = 4.7;
const DROP_END = 5.35;
const END = 5.8;

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

/* ------------------------------------------------------------------ */
/*  Loading                                                           */
/* ------------------------------------------------------------------ */
function loadOne(loader, url) {
  return new Promise((resolve, reject) => {
    loader.load(url, resolve, undefined, reject);
  });
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
      // The GLB materials are double-sided, which shows the inside of the
      // forearm as a translucent veil when the model is close to the camera.
      m.side = THREE.FrontSide;
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

  // Right hand: fixed HUD pose.
  right.position.fromArray(RIGHT_POSE.position);
  right.rotation.set(...RIGHT_POSE.rotation);
  right.scale.setScalar(RIGHT_POSE.scale);
  camera.add(right);
  right.updateMatrixWorld(true);

  // Wick in camera space. Everything about the flame hangs off this point.
  const wickLocal = new THREE.Vector3();
  diyaWick.getWorldPosition(wickLocal);
  camera.worldToLocal(wickLocal);

  // Left hand starts just below the frame.
  left.visible = false;
  left.scale.set(-STRIKE_SCALE, STRIKE_SCALE, STRIKE_SCALE);
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
  const strikePos = new THREE.Vector3();
  const readyPos = new THREE.Vector3();
  const offPos = new THREE.Vector3();
  const lightPos = new THREE.Vector3();
  const lightTipLocal = new THREE.Vector3();
  const carryStartTip = new THREE.Vector3();
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
    left.scale.set(-scale, scale, scale);
    left.updateMatrixWorld(true);
    matchTip.getWorldPosition(solveScratch);
    camera.worldToLocal(solveScratch);
    left.position.add(targetLocal).sub(solveScratch);
    left.updateMatrixWorld(true);
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

    solveLeftClean(strikeLocal, STRIKE_ROT, STRIKE_SCALE);
    strikePos.copy(left.position);
    // The carry begins where the pull-back ends, not at the rock face.
    carryStartTip.copy(strikeLocal).add(PULLBACK);

    readyPos.copy(strikePos).add(new THREE.Vector3(0.02, 0.07, 0.13));
    offPos.copy(strikePos).add(new THREE.Vector3(0.02, -1.15, 0.22));

    // Match tip just above the wick.
    lightTipLocal.copy(wickLocal).add(new THREE.Vector3(0, 0.07, 0.015));
    solveLeftClean(lightTipLocal, LIGHT_ROT, LIGHT_SCALE);
    lightPos.copy(left.position);

    // Reset for the first frame of the pan.
    left.position.copy(offPos);
    left.rotation.set(...STRIKE_ROT);
    left.scale.set(-STRIKE_SCALE, STRIKE_SCALE, STRIKE_SCALE);
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
    //   0.00-1.25  camera turns to the rock, hand rises
    //   1.25-1.55  hand moves onto the stone
    //   1.55-2.30  two short scrapes, ignite on the second
    //   2.30-2.80  match catches, hand pulls back
    //   2.80-4.30  camera returns while the match is carried to the diya
    //   4.30-4.70  flame passes to the wick
    //   4.70-5.35  left hand lowers out of frame
    //   5.35-5.80  settle, hand over to gameplay

    // ---- camera ----
    let yaw = 0;
    let pitch = 0;
    if (time < PAN_END) {
      const e = smoother(time / PAN_END);
      yaw = STRIKE_YAW * e;
      pitch = STRIKE_PITCH * e;
    } else if (time < CARRY_START) {
      yaw = STRIKE_YAW;
      pitch = STRIKE_PITCH;
    } else if (time < CARRY_END) {
      const e = smoother((time - CARRY_START) / (CARRY_END - CARRY_START));
      yaw = STRIKE_YAW * (1 - e);
      pitch = STRIKE_PITCH * (1 - e);
    } else {
      yaw = 0;
      pitch = 0;
    }

    // A tiny hand-held tremor while the match is scraping.
    if (time > APPROACH_END && time < SCRAPE2_END) {
      const k = 0.0028 * Math.sin(time * 54) * Math.sin(time * 37 + 1.1);
      yaw += k;
      pitch += k * 0.6;
    }
    setView(yaw, pitch);
    camera.updateMatrixWorld(true);

    // ---- hand path ----
    if (time < PAN_END) {
      const e = smooth((time - 0.05) / (PAN_END - 0.15));
      left.position.lerpVectors(offPos, readyPos, e);
    } else if (time < APPROACH_END) {
      const e = smooth((time - PAN_END) / (APPROACH_END - PAN_END));
      left.position.lerpVectors(readyPos, strikePos, e);
    } else if (time < SCRAPE1_END) {
      const e = smooth((time - APPROACH_END) / (SCRAPE1_END - APPROACH_END));
      left.position.copy(strikePos).addScaledVector(tangentLocal, SCRAPE_DISTANCE * e);
    } else if (time < SCRAPE2_END) {
      const e = smooth((time - SCRAPE1_END) / (SCRAPE2_END - SCRAPE1_END));
      left.position.copy(strikePos).addScaledVector(tangentLocal, SCRAPE_DISTANCE * (1 - e));
      if (time > IGNITE_AT) ignite();
    } else if (time < CARRY_START) {
      const e = smooth((time - SCRAPE2_END) / (CARRY_START - SCRAPE2_END));
      left.position.copy(strikePos).addScaledVector(PULLBACK, e);
    } else if (time < CARRY_END) {
      // Interpolate the visible tip along a small arc, re-solving the arm so
      // the flame travels smoothly to the wick even as the camera turns back.
      const e = smoother((time - CARRY_START) / (CARRY_END - CARRY_START));
      const t = scratch.copy(carryStartTip).lerp(lightTipLocal, e);
      t.y += Math.sin(Math.PI * e) * 0.11;
      t.x += Math.sin(Math.PI * e) * 0.03;
      const rot = [
        lerp(STRIKE_ROT[0], LIGHT_ROT[0], e),
        lerp(STRIKE_ROT[1], LIGHT_ROT[1], e),
        lerp(STRIKE_ROT[2], LIGHT_ROT[2], e)
      ];
      solveLeftClean(t, rot, lerp(STRIKE_SCALE, LIGHT_SCALE, e));
    } else if (time < TRANSFER_END) {
      solveLeftClean(lightTipLocal, LIGHT_ROT, LIGHT_SCALE);
    } else if (time < DROP_END) {
      const e = smooth((time - TRANSFER_END) / (DROP_END - TRANSFER_END));
      // Drift left while sinking so the hand doesn't just vanish behind the
      // diya: it visibly leaves the lamp and falls out of the bottom corner.
      left.position.copy(lightPos);
      left.position.x -= 0.8 * e;
      left.position.y -= 1.45 * e;
      left.position.z += 0.08 * e;
      left.rotation.set(
        LIGHT_ROT[0] - 0.25 * e,
        LIGHT_ROT[1],
        LIGHT_ROT[2]
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
        const x = lerp(tip.x, wickLocal.x, e);
        const y = lerp(tip.y, wickLocal.y, e);
        const z = lerp(tip.z, wickLocal.z, e);
        const s = lerp(FLAME_MATCH_SCALE, 1, e);
        flame.setWickPosition(x, y, z, s);
        handLight.position.set(x, y + 0.08, z);
        handLight.intensity = lerp(3.0, 4.2, e);
        spot.intensity = lerp(16, 40, e);
      } else {
        flame.setWickPosition(wickLocal.x, wickLocal.y, wickLocal.z, 1);
        handLight.position.copy(wickLocal);
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
