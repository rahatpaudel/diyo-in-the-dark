import * as THREE from './vendor/three.module.js';
import { loadEnvironment } from './environment.js';
import { createFlame } from './flame.js';
import { createWind } from './wind.js';
import { loadHands, createIntro } from './intro.js';
import { buildTerrain, heightAt } from './terrain.js';
import { buildRiddleSign } from './riddle.js';
import {
  pathSummary,
  nearestPath,
  PATH_HALF_WIDTH,
  PATH_DECISIONS,
  HOUSE_POINT
} from './path.js';

/* ------------------------------------------------------------------ */
/*  Game state                                                        */
/* ------------------------------------------------------------------ */
const EYE_HEIGHT = 1.6;
const PATH_CORRIDOR = PATH_HALF_WIDTH + 0.45;
// How far down a decoy branch the player must walk before the forest closes.
// Kept beyond the overlap zone at the fork, so brushing the correct path's
// edge can never be mistaken for choosing a decoy.
const COMMIT_DISTANCE = 3.4;
// Time for the gust to rise and the diya to die before the screen appears.
const STRANDED_SCREEN_DELAY = 4.2;

const state = {
  playing: false,
  gameOver: false,
  won: false,

  // True while the opening ceremony owns the camera and the hands.
  cinematic: false,

  // Secret free-fly inspection mode (toggled with V during play).
  spectator: false,
  spectatorSpeed: 12,

  // Wrong-branch commitment and the stranded sequence.
  stranded: false,
  deathTime: 0,
  deathNode: null,

  keys: {},
  moveSpeed: 3,

  mouseSensitivity: 0.002,

  // Look angles (FPS camera)
  yaw: 0,
  pitch: 0,

  // Fixed timestep
  fixedDt: 1 / 60,
  accumulatedTime: 0
};

/* ------------------------------------------------------------------ */
/*  UI references                                                     */
/* ------------------------------------------------------------------ */
const UI = {
  instructions: document.getElementById('instructions'),
  message: document.getElementById('message'),
  overlay: document.getElementById('overlay'),
  startBtn: document.getElementById('start-btn')
};

/* ------------------------------------------------------------------ */
/*  Three.js scene objects                                            */
/* ------------------------------------------------------------------ */
let scene, camera, renderer, clock;
let light, house, flame, handFill, handFlame, wind;
let environment = null;
let ground = null;
let intro = null;

// Resting-pose reference for the right hand, plus the smoothed gait/sway
// offsets applied on top of it once the ceremony has handed over.
const _handBasePos = new THREE.Vector3();
const _handBaseRot = new THREE.Euler();
const _handWick = new THREE.Vector3();
let handBaseReady = false;
let handBobPhase = 0;
let handIdleTime = 0;
let handWalk = 0;
let handSwayX = 0;
let handSwayYaw = 0;
let handSwayPitch = 0;

// Scratch vectors for per-frame flame motion (no allocations in the loop).
const _prevPos = new THREE.Vector3();
const _velocity = new THREE.Vector3();
const _axisX = new THREE.Vector3();
const _axisY = new THREE.Vector3();
const _axisZ = new THREE.Vector3();

// Mouse look writes to state.yaw/pitch between frames, so the look delta has
// to be measured from the previous *frame* rather than the start of this one.
let _prevYaw = 0;
let _prevPitch = 0;

// Saved when entering spectator mode so exiting puts everything back.
let spectatorSaved = null;
let spectatorLights = null;

/* ------------------------------------------------------------------ */
/*  Initialization                                                    */
/* ------------------------------------------------------------------ */
function init() {
  // Scene
  scene = new THREE.Scene();
  // Cleared manually in renderFrame so the hand HUD pass cannot wipe the
  // world; the clear colour matches the old background.
  scene.background = null;
  scene.fog = new THREE.FogExp2(0x030306, 0.045);

  // Camera
  camera = new THREE.PerspectiveCamera(
    75,
    window.innerWidth / window.innerHeight,
    0.1,
    1000
  );
  camera.position.set(0, EYE_HEIGHT, 0);
  // YXZ prevents the roll/tilt artifact when looking around (FPS order:
  // yaw around Y first, then pitch around X). With the default 'XYZ',
  // moving the mouse up/down can visually rotate/tilt the view.
  camera.rotation.order = 'YXZ';

  // Renderer — performance tuned
  renderer = new THREE.WebGLRenderer({
    canvas: document.getElementById('game-canvas'),
    antialias: true,
    powerPreference: 'high-performance'
  });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // The frame is cleared manually (world pass + HUD pass), so match the
  // scene's background colour here.
  renderer.setClearColor(0x030306, 1);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  clock = new THREE.Clock();

  // The player IS the camera. Add it to the scene so anything attached to
  // it (the diyo) gets its world matrix updated every frame.
  scene.add(camera);

  // No ambient light and no extra lights: the diyo is the ONLY light source.
  // Attached to the camera so it truly emits from the player.
  // Camera looks down -Z in local space, so the light and its target are
  // placed toward -Z (in front of the player).
  light = new THREE.SpotLight(0xff9a3c, 44, 11, Math.PI / 5, 0.5, 1.4);
  light.castShadow = true;
  light.shadow.mapSize.width = 1024;
  light.shadow.mapSize.height = 1024;
  light.shadow.bias = -0.0004;
  light.shadow.normalBias = 0.02;
  // Centered below eye level so the lit pool sits in the middle of the view
  // rather than being pushed to the right by the hand pose.
  light.position.set(0, -0.3, -0.4);
  light.target.position.set(0, -0.7, -6);
  camera.add(light);
  camera.add(light.target);

  // HUD-only fill for the hands. The world lights stay off the hand layer so
  // the close-up hand is never blown out by the flame's world lighting.
  handFill = new THREE.PointLight(0xffb060, 3.0, 2.0, 2);
  handFill.position.set(0.3, 0.2, -0.1);
  handFill.layers.set(1);
  camera.add(handFill);

  // A faint copy of the diya light on the HUD layer. It is driven from the
  // real flame light below, so the hand still catches a little warm light
  // from the flame itself without the full world intensity.
  handFlame = new THREE.PointLight(0xff9a3c, 0, 2.0, 2);
  handFlame.layers.set(1);
  camera.add(handFlame);

  // The visible flame in the player's hand. Stays glued to the bottom-right
  // of the view; the real diya/hand model can replace it later.
  flame = createFlame(camera);
  // HUD layer: drawn after the world with a cleared depth buffer.
  flame.mesh.layers.set(1);

  // Wrong-branch wind. Inert until the player commits to a decoy.
  wind = createWind(scene);

  // World
  ground = buildTerrain(scene, renderer);
  camera.position.y =
    heightAt(camera.position.x, camera.position.z) + EYE_HEIGHT;
  buildHouse();

  // Input
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('resize', onResize);
  window.addEventListener('click', onClick);

  // Pointer lock
  document.addEventListener('pointerlockchange', onPointerLockChange);
  document.addEventListener('pointerlockerror', () => {
    // Pointer lock failed (e.g. iframe). Start anyway — mouse look will be limited.
    console.warn('Pointer lock unavailable; starting without it.');
  });

  // UI — start button
  UI.startBtn.addEventListener('click', startGame);

  // Kick off loop (the world is still empty for a frame; the ASCII loader
  // covers the viewport until the models are in place).
  animate();

  // Load the forest for real — the loading screen is held up by this promise,
  // not by a cosmetic timer.
  loadWorld();
}

/* ------------------------------------------------------------------ */
/*  Load the environment + hands, then let the loader fade away        */
/* ------------------------------------------------------------------ */
function loadWorld() {
  const loader = window.AsciiDiya && window.AsciiDiya.loader;

  const envPromise = loadEnvironment(scene, {
    renderer,
    onProgress: (p) => {
      if (!loader) return;
      loader.setProgress(p);
      if (loader.container) {
        loader.container.setAttribute(
          'aria-label',
          'Lighting the diyo — loading world ' + Math.round(p * 100) + '%'
        );
      }
    }
  });

  // The hands are part of the opening ceremony, so the loader waits for both
  // the forest and the two arm models before it lets the menu in.
  const handsPromise = loadHands();

  // The first riddle site is built in code, so it only needs its SVG icons.
  // A missing icon should not hold the whole forest hostage.
  const riddlePromise = buildRiddleSign(scene, renderer).catch((err) => {
    console.warn('[riddle] could not build the sign:', err);
    return null;
  });

  Promise.all([envPromise, handsPromise, riddlePromise])
    .then(([env, hands, riddle]) => {
      environment = env;
      console.info(
        '[world] ' + env.stats.instances + ' props from ' + env.stats.variants +
          ' models' + (env.stats.missing.length ? ' (missing: ' + env.stats.missing.join(', ') + ')' : '')
      );
      if (window.__DIYO_DEBUG) {
        window.__DIYO_DEBUG.environment = env;
        window.__DIYO_DEBUG.riddle = riddle;
      }

      // An empty world is playable but pointless. Say why, rather than
      // leaving the player walking through a black void.
      if (env.stats.variants === 0) showWorldWarning(env.stats.blocked);

      if (hands) {
        intro = createIntro({
          camera,
          flame,
          spot: light,
          hands,
          environment: env,
          setView,
          onDone: onIntroDone
        });
        if (window.__DIYO_DEBUG) window.__DIYO_DEBUG.intro = intro;

        // Hands are HUD elements: render them on the overlay layer so world
        // geometry can never occlude them. Their fill light is the only light
        // on that layer; the world lights stay off it.
        intro.leftHand.traverse((o) => o.layers.set(1));
        intro.rightHand.traverse((o) => o.layers.set(1));
      }

      // If the hand rig is unavailable the game still works: skip the
      // ceremony and show the standalone flame in the bottom-right.
      if (!intro) {
        flame.setVisible(true);
        light.intensity = 44;
      }

      // Make sure at least one frame with the finished world has been drawn
      // before the loader starts fading.
      requestAnimationFrame(() => {
        renderFrame();
        requestAnimationFrame(() => {
          if (loader) loader.ready();
        });
      });
    })
    .catch((err) => {
      console.error('[world] environment failed to load:', err);
      flame.setVisible(true);
      light.intensity = 44;
      if (loader) loader.ready();
    });
}

/* Tell the player why the forest is missing (file:// or a dead server). */
function showWorldWarning(blocked) {
  const banner = document.getElementById('boot-error');
  if (!banner) return;
  banner.style.display = 'block';
  banner.innerHTML = blocked
    ? 'The forest models cannot be loaded from a <code>file://</code> page.' +
      '<br>Run <code>node server.js</code> in the project folder, then open ' +
      '<code>http://localhost:3000</code>.'
    : 'The forest models failed to load. Check the browser console, then reload.';
  UI.overlay.style.display = 'flex';
}

/* ------------------------------------------------------------------ */
/*  Camera control shared by the intro and the player                  */
/* ------------------------------------------------------------------ */
function setView(yaw, pitch) {
  state.yaw = yaw;
  state.pitch = pitch;
  camera.rotation.set(pitch, yaw, 0);
}

function onIntroDone() {
  state.cinematic = false;
  if (document.pointerLockElement === document.body) {
    UI.instructions.style.display = 'none';
  } else {
    UI.instructions.textContent =
      'Click to resume \u2022 WASD to move \u2022 Mouse to look \u2022 E to interact';
    UI.instructions.style.display = 'block';
  }

  // The ceremony left the hand in its resting pose; that becomes the base for
  // the subtle walk/turn sway below.
  if (intro) {
    _handBasePos.copy(intro.rightHand.position);
    _handBaseRot.copy(intro.rightHand.rotation);
    handBaseReady = true;
    handBobPhase = 0;
    handIdleTime = 0;
    handSwayX = 0;
    handSwayYaw = 0;
    handSwayPitch = 0;
  }
}

/* ------------------------------------------------------------------ */
/*  Start the game — update UI FIRST, then request pointer lock.      */
/*  If pointer lock throws (file://, iframe, unsupported), the game   */
/*  still starts instead of the click appearing to do nothing.        */
/* ------------------------------------------------------------------ */
function startGame() {
  if (state.playing) return;
  state.playing = true;

  // Let the menu dissolve instead of vanishing between frames.
  UI.overlay.classList.add('is-leaving');
  window.setTimeout(() => {
    UI.overlay.style.display = 'none';
    UI.overlay.classList.remove('menu', 'is-leaving');
  }, 500);

  try {
    const lock = document.body.requestPointerLock();
    if (lock && typeof lock.catch === 'function') {
      lock.catch(() => {});
    }
  } catch (e) {
    console.warn('Pointer lock unavailable:', e);
  }

  if (intro) {
    // The ceremony plays before the player gets control. Keep the HUD out of
    // the shot until it hands over.
    state.cinematic = true;
    UI.instructions.style.display = 'none';
    intro.start();
  } else {
    UI.instructions.style.display = 'block';
  }
}

/* ------------------------------------------------------------------ */
/*  World building                                                    */
/* ------------------------------------------------------------------ */
function buildHouse() {
  house = new THREE.Group();
  const hx = HOUSE_POINT.x;
  const hz = HOUSE_POINT.z;
  house.position.set(hx, heightAt(hx, hz), hz);
  // Local +Z is the facade. It faces north, down the trail.
  house.rotation.y = 0;

  const stoneMat = new THREE.MeshStandardMaterial({ color: 0x4a423a, roughness: 0.95 });
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x76573f, roughness: 0.9 });
  const woodMat = new THREE.MeshStandardMaterial({ color: 0x4a2c18, roughness: 0.85 });
  const roofMat = new THREE.MeshStandardMaterial({ color: 0x28150f, roughness: 0.95 });
  const glowMat = new THREE.MeshStandardMaterial({ color: 0x0d0906, roughness: 0.92 });

  const plinth = new THREE.Mesh(new THREE.BoxGeometry(7.6, 0.6, 7.6), stoneMat);
  plinth.position.y = 0.3;
  plinth.castShadow = true;
  plinth.receiveShadow = true;
  house.add(plinth);

  const walls = new THREE.Mesh(new THREE.BoxGeometry(6.4, 3.6, 6.4), wallMat);
  walls.position.y = 2.4;
  walls.castShadow = true;
  walls.receiveShadow = true;
  house.add(walls);

  const roof = new THREE.Mesh(new THREE.ConeGeometry(5.8, 2.8, 4), roofMat);
  roof.position.y = 5.6;
  roof.rotation.y = Math.PI / 4;
  roof.castShadow = true;
  house.add(roof);

  // Recessed doorway with a warm pane behind the frame.
  const doorGlow = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 2.5), glowMat);
  doorGlow.position.set(0, 1.85, 3.205);
  house.add(doorGlow);

  const frame = new THREE.Mesh(new THREE.BoxGeometry(1.9, 2.8, 0.16), woodMat);
  frame.position.set(0, 1.9, 3.18);
  house.add(frame);
  const door = new THREE.Mesh(new THREE.BoxGeometry(1.5, 2.5, 0.1), woodMat);
  door.position.set(0, 1.85, 3.26);
  door.castShadow = true;
  house.add(door);
  // A lit slit at the top of the door reads as a lamp inside.
  const slit = new THREE.Mesh(new THREE.PlaneGeometry(1.3, 0.18), glowMat);
  slit.position.set(0, 2.95, 3.32);
  house.add(slit);

  // Porch roof on two posts.
  const porch = new THREE.Mesh(new THREE.BoxGeometry(4.0, 0.22, 2.0), roofMat);
  porch.position.set(0, 3.55, 4.1);
  porch.castShadow = true;
  house.add(porch);
  for (const x of [-1.7, 1.7]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.18, 3.2, 0.18), woodMat);
    post.position.set(x, 1.6, 4.9);
    post.castShadow = true;
    house.add(post);
  }

  // Warm windows, plus side windows so the house glows from other angles.
  const winMat = new THREE.MeshStandardMaterial({ color: 0x0d0906, roughness: 0.92 });
  const addWindow = (x, y, z, ry) => {
    const w = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 1.1), winMat);
    w.position.set(x, y, z);
    w.rotation.y = ry;
    house.add(w);
  };
  addWindow(-2.15, 3.0, 3.205, 0);
  addWindow(2.15, 3.0, 3.205, 0);
  addWindow(-3.205, 3.0, 0, -Math.PI / 2);
  addWindow(3.205, 3.0, 0, Math.PI / 2);

  // Marigold garland over the door.
  const marigold = new THREE.MeshStandardMaterial({
    color: 0x6b3c10,
    roughness: 0.85
  });
  for (let i = 0; i < 9; i++) {
    const flower = new THREE.Mesh(new THREE.SphereGeometry(0.12, 6, 5), marigold);
    const t = i / 8;
    flower.position.set(-1.25 + t * 2.5, 3.35 - Math.sin(t * Math.PI) * 0.28, 3.45);
    house.add(flower);
  }

  const step = new THREE.Mesh(new THREE.BoxGeometry(3.0, 0.2, 1.2), stoneMat);
  step.position.set(0, 0.15, 3.9);
  step.receiveShadow = true;
  house.add(step);

  scene.add(house);
}

/* ------------------------------------------------------------------ */
/*  Input                                                             */
/* ------------------------------------------------------------------ */
function onKeyDown(e) {
  // The opening ceremony owns the camera; don't queue movement or toggles.
  if (state.cinematic) return;

  // Hidden spectator toggle. Deliberately absent from the normal HUD.
  if (
    e.code === 'KeyV' &&
    !e.repeat &&
    !e.ctrlKey &&
    !e.metaKey &&
    !e.altKey &&
    state.playing &&
    !state.gameOver &&
    !state.won &&
    !state.stranded
  ) {
    toggleSpectator();
    return;
  }

  // In spectator mode Space/Shift are flight controls, not page scroll.
  if (
    state.spectator &&
    (e.code === 'Space' || e.code === 'ShiftLeft' || e.code === 'ShiftRight')
  ) {
    e.preventDefault();
  }

  state.keys[e.code] = true;
}

function onKeyUp(e) {
  state.keys[e.code] = false;
}

/* ------------------------------------------------------------------ */
/*  Secret spectator mode                                             */
/* ------------------------------------------------------------------ */
function toggleSpectator() {
  if (state.spectator) exitSpectator();
  else enterSpectator();
}

function enterSpectator() {
  if (state.spectator || !state.playing || state.gameOver || state.won) return;
  state.spectator = true;
  state.keys = {};
  state.accumulatedTime = 0;
  UI.message.style.display = 'none';

  // Remember the player's spot so leaving the mode puts them back on the
  // ground exactly where they were, not wherever the camera flew to.
  spectatorSaved = {
    position: camera.position.clone(),
    yaw: state.yaw,
    pitch: state.pitch,
    fog: scene.fog,
    clearColor: renderer.getClearColor(new THREE.Color()),
    clearAlpha: renderer.getClearAlpha(),
    lightIntensity: light.intensity,
    lightVisible: light.visible,
    lightCastShadow: light.castShadow
  };

  // Fullbright inspection: no fog, a daylight sky, no orange cone, and soft
  // shadowless light from every direction instead of the diyo's cramped pool.
  scene.fog = null;
  renderer.setClearColor(0x8fa6c4, 1);
  light.visible = false;

  const sun = new THREE.DirectionalLight(0xfff2dd, 5);
  sun.position.set(-30, 45, 20);
  sun.target.position.set(0, 0, -10);
  const sky = new THREE.HemisphereLight(0xcfe0ff, 0x5a5040, 4);
  scene.add(sun, sun.target, sky);
  spectatorLights = { sun, sky };

  document.body.classList.add('is-spectator');
}

function exitSpectator() {
  if (!state.spectator) return;
  state.spectator = false;
  state.keys = {};
  state.accumulatedTime = 0;

  if (spectatorLights) {
    scene.remove(spectatorLights.sun.target);
    scene.remove(spectatorLights.sun);
    scene.remove(spectatorLights.sky);
    spectatorLights = null;
  }

  if (spectatorSaved) {
    scene.fog = spectatorSaved.fog;
    renderer.setClearColor(spectatorSaved.clearColor, spectatorSaved.clearAlpha);
    light.visible = spectatorSaved.lightVisible;
    light.intensity = spectatorSaved.lightIntensity;
    light.castShadow = spectatorSaved.lightCastShadow;

    camera.position.copy(spectatorSaved.position);
    state.yaw = spectatorSaved.yaw;
    state.pitch = spectatorSaved.pitch;
    camera.rotation.set(state.pitch, state.yaw, 0);
    spectatorSaved = null;
  }

  document.body.classList.remove('is-spectator');
}

function onMouseMove(e) {
  if (
    !state.playing ||
    state.gameOver ||
    state.won ||
    state.cinematic ||
    document.pointerLockElement !== document.body
  ) {
    return;
  }

  // Accumulate yaw freely, clamp pitch to just under straight up/down.
  state.yaw -= e.movementX * state.mouseSensitivity;
  state.pitch -= e.movementY * state.mouseSensitivity;

  const limit = Math.PI / 2 - 0.01;
  state.pitch = Math.max(-limit, Math.min(limit, state.pitch));

  // Apply with zero roll (z = 0) in YXZ order.
  camera.rotation.set(state.pitch, state.yaw, 0);
}

function onClick() {
  // After Esc, pointer lock is released but the game is still active —
  // a click must re-acquire it. (Previously this only fired before the
  // game started, so you could never get focus back.)
  if (!state.playing || state.gameOver || state.won) return;
  if (document.pointerLockElement !== document.body) {
    document.body.requestPointerLock();
  }
}

function onPointerLockChange() {
  const locked = document.pointerLockElement === document.body;

  // During the ceremony the instructions stay off screen, even if pointer
  // lock is acquired straight from the start click.
  if (state.cinematic) {
    UI.instructions.style.display = 'none';
    return;
  }

  if (locked) {
    UI.instructions.style.display = 'none';
  } else {
    if (state.playing && !state.gameOver && !state.won) {
      UI.instructions.textContent = state.spectator
        ? 'Click to resume \u2022 SPECTATOR: WASD fly \u2022 Space up \u2022 Shift down \u2022 V to exit'
        : 'Click to resume \u2022 WASD to move \u2022 Mouse to look \u2022 E to interact';
      UI.instructions.style.display = 'block';
    } else {
      UI.instructions.style.display = 'none';
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Gameplay update (fixed timestep)                                  */
/* ------------------------------------------------------------------ */

function updatePlayer(dt) {
  if (!state.playing || state.gameOver || state.won || state.cinematic) {
    return;
  }

  // Once the forest has caught the player, movement is over. Only the look
  // controls and the dying diya remain until the stranded screen appears.
  if (state.stranded) {
    updateStranded(dt);
    return;
  }

  const speed = state.moveSpeed * dt;
  const move = new THREE.Vector3();

  const forward = new THREE.Vector3();
  camera.getWorldDirection(forward);
  forward.y = 0;
  forward.normalize();

  // right = forward x up  (the reverse order points left, swapping A/D)
  const right = new THREE.Vector3().crossVectors(forward, camera.up).normalize();

  if (state.keys['KeyW']) move.add(forward);
  if (state.keys['KeyS']) move.sub(forward);
  if (state.keys['KeyA']) move.sub(right);
  if (state.keys['KeyD']) move.add(right);

  if (move.lengthSq() > 0) {
    move.normalize();
    camera.position.addScaledVector(move, speed);

    // The trail is the game board. There is no tree collision; steering is
    // simply held inside the path corridor.
    const near = nearestPath(camera.position.x, camera.position.z, 40);
    if (near && near.dist > PATH_CORRIDOR) {
      const dx = camera.position.x - near.sample.x;
      const dz = camera.position.z - near.sample.z;
      const d = Math.hypot(dx, dz) || 1;
      camera.position.x = near.sample.x + (dx / d) * PATH_CORRIDOR;
      camera.position.z = near.sample.z + (dz / d) * PATH_CORRIDOR;
    }

    camera.position.y =
      heightAt(camera.position.x, camera.position.z) + EYE_HEIGHT;
  }

  // A decoy branch is a commitment. Walking a couple of metres past its fork
  // hands the player to the wind; there is no walking back out.
  checkWrongPath();
  if (state.stranded) return;

  // Consume interact key
  if (state.keys['KeyE']) {
    delete state.keys['KeyE'];
    const dHouse = camera.position.distanceTo(house.position);
    if (dHouse < 5) {
      endGame();
    }
  }

  // The spotlight and the visible flame share one breathing rhythm.
  light.intensity = 44 * flame.flicker;

  checkInteractions();
}

function checkWrongPath() {
  if (state.gameOver || state.won || state.stranded) return;

  const near = nearestPath(camera.position.x, camera.position.z, 12);
  if (!near || near.kind !== 'decoy' || !near.decision) return;

  const node = PATH_DECISIONS.find((d) => d.id === near.decision);
  if (!node) return;

  const committed = Math.hypot(
    camera.position.x - node.x,
    camera.position.z - node.z
  );
  if (committed < COMMIT_DISTANCE) return;

  startStranded(node);
}

function startStranded(node) {
  state.stranded = true;
  state.deathTime = 0;
  state.deathNode = node;
  state.keys = {};
  UI.message.style.display = 'none';
  UI.instructions.style.display = 'none';
}

function updateStranded(dt) {
  state.deathTime += dt;
  const t = state.deathTime;

  // The flame gutters for a while, then the light is gone.
  const fade = Math.max(0, 1 - t / 2.8);
  const sputter = t < 2.8 ? 0.55 + 0.45 * Math.sin(t * 26 + 1.2) : 0;
  light.intensity = 44 * fade * sputter;
  if (fade <= 0 && flame.mesh.visible) flame.setVisible(false);
  if (intro) intro.handLight.intensity = 4.6 * fade;

  if (t >= STRANDED_SCREEN_DELAY) showStrandedScreen();
}

function showStrandedScreen() {
  if (state.gameOver) return;
  state.playing = false;
  state.gameOver = true;
  state.won = false;

  if (document.exitPointerLock) document.exitPointerLock();

  UI.instructions.style.display = 'none';
  UI.message.style.display = 'none';
  UI.overlay.classList.remove('menu', 'is-leaving');
  UI.overlay.classList.add('stranded');
  UI.overlay.innerHTML = `
    <h1 style="color:#d98b6a">You are stranded</h1>
    <p>The wind took your diyo. The forest keeps what it catches.</p>
    <div class="overlay-actions">
      <button id="respawn-btn" type="button">Respawn</button>
      <button id="home-btn" type="button">Home</button>
    </div>
  `;
  UI.overlay.style.display = 'flex';

  const respawnBtn = document.getElementById('respawn-btn');
  const homeBtn = document.getElementById('home-btn');
  if (respawnBtn) respawnBtn.addEventListener('click', respawn);
  if (homeBtn) {
    homeBtn.addEventListener('click', () => {
      window.location.reload();
    });
  }
}

function respawn() {
  const node = state.deathNode || PATH_DECISIONS[0];

  // Put the player a couple of metres before the failed fork, on the incoming
  // trail, looking straight at it.
  let px = node.x;
  let pz = node.z + 2.4;
  const near = nearestPath(px, pz, 8);
  if (near) {
    px = near.sample.x;
    pz = near.sample.z;
  }

  state.playing = true;
  state.gameOver = false;
  state.won = false;
  state.stranded = false;
  state.deathTime = 0;
  state.deathNode = null;
  state.keys = {};
  state.accumulatedTime = 0;

  camera.position.set(px, heightAt(px, pz) + EYE_HEIGHT, pz);
  const yaw = Math.atan2(-(node.x - px), -(node.z - pz));
  state.yaw = yaw;
  state.pitch = 0;
  camera.rotation.set(0, yaw, 0);
  _prevYaw = yaw;
  _prevPitch = 0;

  light.visible = true;
  light.intensity = 44;
  flame.setVisible(true);
  if (flame.ignite) flame.ignite();
  if (intro) intro.handLight.intensity = 4.6;

  UI.overlay.style.display = 'none';
  UI.overlay.classList.remove('stranded');
  UI.overlay.innerHTML = '';
  UI.message.style.display = 'none';

  try {
    const lock = document.body.requestPointerLock();
    if (lock && typeof lock.catch === 'function') lock.catch(() => {});
  } catch (e) {
    console.warn('Pointer lock unavailable:', e);
  }
  UI.instructions.textContent =
    'Click to resume \u2022 WASD to move \u2022 Mouse to look \u2022 E to interact';
  UI.instructions.style.display =
    document.pointerLockElement === document.body ? 'none' : 'block';
}

function checkInteractions() {
  const dHouse = camera.position.distanceTo(house.position);
  if (dHouse < 5) {
    UI.message.textContent = 'Press E to leave your Diyo at the house';
    UI.message.style.display = 'block';
  } else {
    UI.message.style.display = 'none';
  }
}

/* ------------------------------------------------------------------ */
/*  Spectator flight (fixed timestep)                                 */
/* ------------------------------------------------------------------ */
function updateSpectator(dt) {
  if (!state.spectator || !state.playing || state.cinematic) return;

  const speed = state.spectatorSpeed * dt;
  const move = new THREE.Vector3();

  // W follows the full view direction, so looking up and pressing W climbs.
  const forward = new THREE.Vector3();
  camera.getWorldDirection(forward);

  // Keep strafing horizontal even when pitched straight up or down.
  const flat = new THREE.Vector3(forward.x, 0, forward.z);
  if (flat.lengthSq() < 1e-6) flat.set(-Math.sin(state.yaw), 0, -Math.cos(state.yaw));
  flat.normalize();
  const right = new THREE.Vector3().crossVectors(flat, camera.up).normalize();

  if (state.keys['KeyW']) move.add(forward);
  if (state.keys['KeyS']) move.sub(forward);
  if (state.keys['KeyA']) move.sub(right);
  if (state.keys['KeyD']) move.add(right);
  if (state.keys['Space']) move.y += 1;
  if (state.keys['ShiftLeft'] || state.keys['ShiftRight']) move.y -= 1;

  if (move.lengthSq() > 0) {
    camera.position.addScaledVector(move.normalize(), speed);
  }
}

/* ------------------------------------------------------------------ */
/*  End game                                                          */
/* ------------------------------------------------------------------ */
function endGame() {
  state.playing = false;
  state.gameOver = true;
  state.won = true;

  if (document.exitPointerLock) {
    document.exitPointerLock();
  }

  UI.overlay.innerHTML = `
    <h1 style="color:#ffaa00">HOUSE LIGHTED</h1>
    <p>You carried the Diyo through the dark and lit the house.<br>It glows warm against the forest.</p>
    <button onclick="location.reload()">Play Again</button>
  `;

  UI.overlay.style.display = 'flex';

  house.traverse((child) => {
    if (!child.isMesh || !child.material) return;
    if (child.material.emissive) {
      // Standard materials: light up via emissive
      child.material.emissive.set(0xffaa00);
      child.material.emissiveIntensity = 0.5;
    } else if (child.material.color) {
      // Basic materials (windows): brighten the color instead
      child.material.color.set(0xffd27a);
    }
  });
}

/* ------------------------------------------------------------------ */
/*  Loop — fixed timestep logic + render                              */
/* ------------------------------------------------------------------ */
function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

/* ------------------------------------------------------------------ */
/*  Right-hand HUD motion                                              */
/* ------------------------------------------------------------------ */
function updateHandBob(dt, motion) {
  if (!handBaseReady || !intro) return;
  const hand = intro.rightHand;
  const step = Math.min(dt || 0, 0.1);
  handIdleTime += step;

  // Drive the gait from the movement keys and smooth it, rather than from
  // per-frame camera displacement. Fixed-timestep movement alternates between
  // zero and several steps per frame, which made the raw speed (and the bob)
  // jitter badly.
  const moving =
    state.keys['KeyW'] ||
    state.keys['KeyS'] ||
    state.keys['KeyA'] ||
    state.keys['KeyD'];
  handWalk += ((moving ? 1 : 0) - handWalk) * (1 - Math.exp(-9 * step));
  const gait = handWalk * handWalk;

  // Two-step vertical cadence with a slower side-to-side sway.
  handBobPhase += step * (4.2 + 3.8 * handWalk);
  const bobY =
    Math.sin(handBobPhase * 1.15) * 0.0032 * gait +
    Math.sin(handIdleTime * 1.25) * 0.00045;
  const bobX =
    Math.cos(handBobPhase * 0.62) * 0.002 * gait +
    Math.sin(handIdleTime * 0.9 + 0.6) * 0.0003;
  const bobRoll = Math.sin(handBobPhase * 0.9) * 0.0035 * gait;

  // The hand lags behind fast camera turns, then eases back when the turn
  // stops. Rates are per second so the feel is frame-rate independent.
  const inv = 1 / Math.max(step, 1e-3);
  const yawRate = (motion.yawDelta || 0) * inv;
  const pitchRate = (motion.pitchDelta || 0) * inv;
  const targetYaw = Math.max(-0.05, Math.min(0.05, -yawRate * 0.02));
  const targetPitch = Math.max(-0.035, Math.min(0.035, -pitchRate * 0.012));
  const targetX = Math.max(-0.008, Math.min(0.008, -yawRate * 0.0025));
  const ease = 1 - Math.exp(-12 * step);
  handSwayYaw += (targetYaw - handSwayYaw) * ease;
  handSwayPitch += (targetPitch - handSwayPitch) * ease;
  handSwayX += (targetX - handSwayX) * ease;

  hand.position.set(
    _handBasePos.x + bobX + handSwayX,
    _handBasePos.y + bobY,
    _handBasePos.z
  );
  hand.rotation.set(
    _handBaseRot.x + handSwayPitch + bobRoll * 0.3,
    _handBaseRot.y + handSwayYaw,
    _handBaseRot.z + bobRoll
  );
  camera.updateMatrixWorld(true);

  // The flame is anchored to the wick, so it has to follow the sway.
  const wick = hand.getObjectByName('diya_wick');
  if (!wick) return;
  wick.getWorldPosition(_handWick);
  camera.worldToLocal(_handWick);
  intro.wickLocal.copy(_handWick);
  flame.setWickPosition(
    _handWick.x,
    _handWick.y,
    _handWick.z,
    flame.mesh.scale.x
  );
  intro.handLight.position.set(_handWick.x, _handWick.y + 0.08, _handWick.z);
}

/* ------------------------------------------------------------------ */
/*  Render — world first, then the hand HUD over a cleared depth buffer */
/* ------------------------------------------------------------------ */
function renderFrame() {
  renderer.autoClear = false;
  renderer.clear();

  camera.layers.set(0);
  renderer.render(scene, camera);

  // The hands (and their flame) must never disappear inside a tree or wall.
  renderer.shadowMap.autoUpdate = false;
  renderer.clearDepth();
  camera.layers.set(1);
  renderer.render(scene, camera);
  renderer.shadowMap.autoUpdate = true;
  camera.layers.set(0);
}

function animate() {
  requestAnimationFrame(animate);
  const rawDelta = clock.getDelta();
  const delta = Math.min(rawDelta, 0.1);

  _prevPos.copy(camera.position);

  // Fixed timestep for consistent gameplay regardless of frame rate
  state.accumulatedTime += delta;
  while (state.accumulatedTime >= state.fixedDt) {
    if (state.spectator) updateSpectator(state.fixedDt);
    else updatePlayer(state.fixedDt);
    state.accumulatedTime -= state.fixedDt;
  }

  // Opening ceremony: it drives the camera, both hands, the flame and both
  // lights. It runs before the flame's lean update so shared state is fresh.
  if (intro && state.cinematic) intro.update(rawDelta);

  // Turn movement and looking into camera-local velocity so the flame can
  // lean against them. This runs even before start / after winning: the flame
  // is part of the view at all times, not a gameplay object.
  _velocity.copy(camera.position).sub(_prevPos).divideScalar(Math.max(delta, 1e-4));
  _axisX.set(1, 0, 0).applyQuaternion(camera.quaternion);
  _axisY.set(0, 1, 0).applyQuaternion(camera.quaternion);
  _axisZ.set(0, 0, 1).applyQuaternion(camera.quaternion);
  const localX = _velocity.dot(_axisX);
  const localY = _velocity.dot(_axisY);
  const localZ = _velocity.dot(_axisZ);
  const yawDelta = state.yaw - _prevYaw;
  const pitchDelta = state.pitch - _prevPitch;
  flame.update(rawDelta, {
    localX,
    localY,
    localZ,
    yawDelta,
    pitchDelta,
    speed: _velocity.length()
  });

  // The match's initial catch is applied after flame.update, otherwise the
  // flame's own flicker would overwrite it every frame.
  if (intro && state.cinematic) {
    flame.uniforms.uIntensity.value *= intro.flameBoost;
  }

  // Keep the ceremony's pre-ignition shot dark: the hand fill only comes up
  // once the match actually catches.
  if (handFill) {
    let target = 0;
    if (state.cinematic) {
      target = intro && intro.lit ? 3.0 : 0.15;
    } else if (state.playing) {
      target = state.stranded
        ? 3.0 * Math.max(0, 1 - state.deathTime / 2.8)
        : 3.0;
    }
    handFill.intensity +=
      (target - handFill.intensity) * (1 - Math.exp(-7 * delta));
  }

  // Subtle sway/bob on the resting hand, and the flame follows its wick.
  if (handBaseReady && !state.cinematic) {
    updateHandBob(rawDelta, { localX, localZ, yawDelta, pitchDelta });
  }

  // Let the HUD hand catch a fraction of the real flame light. The flame's
  // full point light stays on the world layer, so this is only a soft warm
  // wash and never the blown-out white it used to be.
  if (handFlame) {
    if (intro) {
      handFlame.position.copy(intro.handLight.position);
      handFlame.intensity = intro.handLight.intensity * 0.22;
    } else {
      handFlame.intensity = 0;
    }
  }

  if (wind) wind.update(delta, camera.position, state.stranded);

  // Remember the look angles for the next frame: mousemove fires between
  // frames, so this is the only place the change can be measured.
  _prevYaw = state.yaw;
  _prevPitch = state.pitch;

  renderFrame();
}

try {
  // Lightweight debug handle (useful for testing/tuning).
  window.__DIYO_DEBUG = { state, loader: window.AsciiDiya && window.AsciiDiya.loader };
  init();
  window.__DIYO_DEBUG.camera = camera;
  window.__DIYO_DEBUG.scene = scene;
  window.__DIYO_DEBUG.renderer = renderer;
  window.__DIYO_DEBUG.flame = flame;
  window.__DIYO_DEBUG.handFill = handFill;
  window.__DIYO_DEBUG.toggleSpectator = toggleSpectator;
  window.__DIYO_DEBUG.terrainHeight = heightAt;
  window.__DIYO_DEBUG.path = pathSummary();
  window.__DIYO_READY = true;
} catch (err) {
  console.error('Diyo failed to start:', err);
  if (window.__DIYO_SHOW_ERROR) {
    window.__DIYO_SHOW_ERROR(err);
  }
}
