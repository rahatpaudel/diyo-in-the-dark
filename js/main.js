import * as THREE from './vendor/three.module.js';
import { loadEnvironment } from './environment.js';
import { createFlame } from './flame.js';
import { loadHands, createIntro } from './intro.js';

/* ------------------------------------------------------------------ */
/*  Game state                                                        */
/* ------------------------------------------------------------------ */
const state = {
  playing: false,
  gameOver: false,
  won: false,

  // True while the opening ceremony owns the camera and the hands.
  cinematic: false,

  // Secret free-fly inspection mode (toggled with V during play).
  spectator: false,
  spectatorSpeed: 12,

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
  crosshair: document.getElementById('crosshair'),
  message: document.getElementById('message'),
  overlay: document.getElementById('overlay'),
  startBtn: document.getElementById('start-btn')
};

/* ------------------------------------------------------------------ */
/*  Three.js scene objects                                            */
/* ------------------------------------------------------------------ */
let scene, camera, renderer, clock;
let light, house, flame;
let environment = null;
let ground = null;
let intro = null;

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
  scene.background = new THREE.Color(0x030306);
  scene.fog = new THREE.FogExp2(0x030306, 0.045);

  // Camera
  camera = new THREE.PerspectiveCamera(
    75,
    window.innerWidth / window.innerHeight,
    0.1,
    1000
  );
  camera.position.set(0, 1.6, 0);
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
  light = new THREE.SpotLight(0xff9a3c, 40, 35, Math.PI / 5, 0.5, 1.2);
  light.castShadow = true;
  light.shadow.mapSize.width = 1024;
  light.shadow.mapSize.height = 1024;
  // Slightly right and below eye level, like a lamp held in the hand.
  light.position.set(0.3, -0.3, -0.4);
  light.target.position.set(0.3, -0.7, -6);
  camera.add(light);
  camera.add(light.target);

  // The visible flame in the player's hand. Stays glued to the bottom-right
  // of the view; the real diya/hand model can replace it later.
  flame = createFlame(camera);

  // World
  buildGround();
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

  Promise.all([envPromise, handsPromise])
    .then(([env, hands]) => {
      environment = env;
      console.info(
        '[world] ' + env.stats.instances + ' props from ' + env.stats.variants +
          ' models' + (env.stats.missing.length ? ' (missing: ' + env.stats.missing.join(', ') + ')' : '')
      );
      if (window.__DIYO_DEBUG) window.__DIYO_DEBUG.environment = env;

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
      }

      // If the hand rig is unavailable the game still works: skip the
      // ceremony and show the standalone flame in the bottom-right.
      if (!intro) {
        flame.setVisible(true);
        light.intensity = 40;
      }

      // Make sure at least one frame with the finished world has been drawn
      // before the loader starts fading.
      requestAnimationFrame(() => {
        renderer.render(scene, camera);
        requestAnimationFrame(() => {
          if (loader) loader.ready();
        });
      });
    })
    .catch((err) => {
      console.error('[world] environment failed to load:', err);
      flame.setVisible(true);
      light.intensity = 40;
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
  UI.crosshair.style.display = 'block';
  if (document.pointerLockElement === document.body) {
    UI.instructions.style.display = 'none';
  } else {
    UI.instructions.textContent =
      'Click to resume \u2022 WASD to move \u2022 Mouse to look \u2022 E to interact';
    UI.instructions.style.display = 'block';
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
    UI.crosshair.style.display = 'none';
    intro.start();
  } else {
    UI.instructions.style.display = 'block';
    UI.crosshair.style.display = 'block';
  }
}

/* ------------------------------------------------------------------ */
/*  World building                                                    */
/* ------------------------------------------------------------------ */
function buildGround() {
  const geo = new THREE.PlaneGeometry(220, 220);
  const mat = new THREE.MeshStandardMaterial({ color: 0x121b12, roughness: 1 });
  ground = new THREE.Mesh(geo, mat);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);
}

function buildHouse() {
  house = new THREE.Group();
  house.position.set(25, 0, 25);
  // Turn the facade (door + windows) toward the spawn, so the house greets
  // the player instead of showing them its back wall.
  house.rotation.y = -Math.PI * 0.75;

  const wallMat = new THREE.MeshStandardMaterial({ color: 0x2a2222, roughness: 0.8 });
  const roofMat = new THREE.MeshStandardMaterial({ color: 0x141010 });

  const walls = new THREE.Mesh(new THREE.BoxGeometry(8, 5, 8), wallMat);
  walls.position.y = 2.5;
  walls.castShadow = true;
  walls.receiveShadow = true;
  house.add(walls);

  const roof = new THREE.Mesh(new THREE.ConeGeometry(6, 4, 4), roofMat);
  roof.position.y = 5.6;
  roof.rotation.y = Math.PI / 4;
  roof.castShadow = true;
  house.add(roof);

  const door = new THREE.Mesh(
    new THREE.BoxGeometry(1.2, 2.2, 0.18),
    new THREE.MeshStandardMaterial({ color: 0x5d3a1a })
  );
  door.position.set(0, 1.6, 4.01);
  door.castShadow = true;
  house.add(door);

  // The windows are the beacon: unlit, and deliberately ignoring fog so the
  // house reads as a warm dot from anywhere in the woods. They emit no light,
  // so the diyo is still the only light source in the scene.
  const winMat = new THREE.MeshBasicMaterial({ color: 0xffcc66, fog: false });
  const winGeo = new THREE.BoxGeometry(1, 1, 0.18);
  const addWindow = (x, y, z, ry) => {
    const w = new THREE.Mesh(winGeo, winMat);
    w.position.set(x, y, z);
    w.rotation.y = ry;
    house.add(w);
  };
  // Two on the facade...
  addWindow(-2.5, 3, 4.01, 0);
  addWindow(2.5, 3, 4.01, 0);
  // ...and one on each remaining wall, so the glow is visible from any side.
  addWindow(0, 3, -4.01, 0);
  addWindow(-4.01, 3, 0, Math.PI / 2);
  addWindow(4.01, 3, 0, Math.PI / 2);

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
    !state.won
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
    background: scene.background.clone(),
    groundColor: ground.material.color.clone(),
    lightIntensity: light.intensity,
    lightVisible: light.visible,
    lightCastShadow: light.castShadow
  };

  // Fullbright inspection: no fog, a daylight sky, no orange cone, and soft
  // shadowless light from every direction instead of the diyo's cramped pool.
  scene.fog = null;
  scene.background.set(0x8fa6c4);
  ground.material.color.set(0x39523a);
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
    scene.background.copy(spectatorSaved.background);
    ground.material.color.copy(spectatorSaved.groundColor);
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

  // During the ceremony neither the crosshair nor the instructions belong on
  // screen, even if pointer lock is acquired straight from the start click.
  if (state.cinematic) {
    UI.crosshair.style.display = 'none';
    UI.instructions.style.display = 'none';
    return;
  }

  if (locked) {
    UI.instructions.style.display = 'none';
    UI.crosshair.style.display = 'block';
  } else {
    UI.crosshair.style.display = 'none';
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
  }

  // Consume interact key
  if (state.keys['KeyE']) {
    delete state.keys['KeyE'];
    const dHouse = camera.position.distanceTo(house.position);
    if (dHouse < 5) {
      endGame();
    }
  }

  // The spotlight and the visible flame share one breathing rhythm.
  light.intensity = 40 * flame.flicker;

  checkInteractions();
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
  flame.update(rawDelta, {
    localX: _velocity.dot(_axisX),
    localY: _velocity.dot(_axisY),
    localZ: _velocity.dot(_axisZ),
    yawDelta: state.yaw - _prevYaw,
    pitchDelta: state.pitch - _prevPitch,
    speed: _velocity.length()
  });

  // The match's initial catch is applied after flame.update, otherwise the
  // flame's own flicker would overwrite it every frame.
  if (intro && state.cinematic) {
    flame.uniforms.uIntensity.value *= intro.flameBoost;
  }

  // Remember the look angles for the next frame: mousemove fires between
  // frames, so this is the only place the change can be measured.
  _prevYaw = state.yaw;
  _prevPitch = state.pitch;

  renderer.render(scene, camera);
}

try {
  // Lightweight debug handle (useful for testing/tuning).
  window.__DIYO_DEBUG = { state, loader: window.AsciiDiya && window.AsciiDiya.loader };
  init();
  window.__DIYO_DEBUG.camera = camera;
  window.__DIYO_DEBUG.scene = scene;
  window.__DIYO_DEBUG.renderer = renderer;
  window.__DIYO_DEBUG.flame = flame;
  window.__DIYO_DEBUG.toggleSpectator = toggleSpectator;
  window.__DIYO_READY = true;
} catch (err) {
  console.error('Diyo failed to start:', err);
  if (window.__DIYO_SHOW_ERROR) {
    window.__DIYO_SHOW_ERROR(err);
  }
}
