/**
 * The diyo flame that rides in the bottom-right of the view.
 *
 * A single camera-attached billboard with a procedural GLSL flame: layered
 * teardrop silhouette, advected noise for turbulence, a white-hot core and a
 * faint blue root at the wick. No textures and one draw call, so it is cheap
 * enough to keep on screen at all times.
 *
 * The flame has inertia. Motion and turning feed a damped spring that bends
 * the tip away from the direction of travel, and speed stretches and makes it
 * flicker faster. `flicker` is also used by the gameplay spotlight so the
 * world light and the visible flame breathe together.
 */
import * as THREE from './vendor/three.module.js';

const VERT = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAG = `
  precision highp float;

  uniform float uTime;
  uniform float uSpeed;
  uniform float uDepth;
  uniform float uIntensity;
  uniform vec2  uLean;
  uniform float uSeed;
  varying vec2 vUv;

  float hash(vec2 p) {
    p = fract(p * vec2(123.34, 345.45));
    p += dot(p, p + 34.345);
    return fract(p.x * p.y);
  }

  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash(i);
    float b = hash(i + vec2(1.0, 0.0));
    float c = hash(i + vec2(0.0, 1.0));
    float d = hash(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }

  float fbm(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 3; i++) {
      v += a * vnoise(p);
      p = p * 2.02 + 17.1;
      a *= 0.5;
    }
    return v;
  }

  void main() {
    float t = uTime * (1.0 + uSpeed * 0.8);
    vec2 p = vec2(vUv.x - 0.5, vUv.y);
    p.y *= 1.0 - uSpeed * 0.10;      // faster movement stretches the flame

    float h = clamp(p.y, 0.0, 1.0);
    // Walking forward presses the flame slightly back toward the hand: it
    // gets shorter and shivers a little instead of bending sideways.
    p.y += uDepth * 0.07 * h;
    float bend = uLean.x * h * h * 1.25 + sin(t * 1.7 + h * 4.0) * 0.012 * h
                 + sin(t * 5.0) * uDepth * 0.02 * h;
    p.x -= bend;
    p.y -= uLean.y * h * h * 0.25;

    // Turbulence drifts upward, so the silhouette never looks like a still
    // triangle. Each octave is sampled in flame space, not screen space.
    float n = fbm(vec2(p.x * 6.0 + uSeed, h * 3.5 - t * 1.15));
    float wobble = (n - 0.5) * 0.20 * h;
    float dx = abs(p.x - wobble);

    float taper = pow(1.0 - h, 0.65);
    float radius = 0.15 * taper + 0.015;
    radius *= 0.8 + 0.45 * exp(-pow((h - 0.22) / 0.22, 2.0)); // fat lower third
    radius *= 0.85 + 0.3 * n;

    float shape = 1.0 - smoothstep(radius * 0.55, radius, dx);
    shape *= smoothstep(0.0, 0.06, h);
    shape *= 1.0 - smoothstep(0.72, 1.0, h);
    shape *= 0.72 + 0.38 * fbm(vec2(p.x * 9.0, h * 5.0 - t * 2.2));
    shape = clamp(shape, 0.0, 1.0);

    float core = 1.0 - smoothstep(0.0, radius * 0.52, dx);
    core *= 1.0 - smoothstep(0.35, 0.85, h);

    vec3 outer = vec3(1.0, 0.28, 0.03);
    vec3 mid   = vec3(1.0, 0.62, 0.10);
    vec3 hot   = vec3(1.0, 0.96, 0.68);
    vec3 col = mix(outer, mid, core);
    col = mix(col, hot, pow(core, 2.2) * 0.9);

    // A hint of blue right at the wick, like a real oil-lamp flame.
    col = mix(col, vec3(0.35, 0.55, 1.0),
              (1.0 - smoothstep(0.02, 0.10, h)) * core * 0.45);

    float halo = exp(-dx * dx / 0.06) * exp(-pow((h - 0.28) / 0.42, 2.0));
    col += vec3(1.0, 0.25, 0.04) * halo * 0.35;

    float alpha = clamp(shape + halo * 0.25, 0.0, 1.0) * uIntensity;
    gl_FragColor = vec4(col, alpha);
  }
`;

const clamp = THREE.MathUtils.clamp;

export function createFlame(camera) {
  const uniforms = {
    uTime: { value: 0 },
    uSpeed: { value: 0 },
    uDepth: { value: 0 },
    uIntensity: { value: 1 },
    uLean: { value: new THREE.Vector2() },
    uSeed: { value: 3.7 }
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false
  });

  const geometry = new THREE.PlaneGeometry(0.26, 0.34);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'DiyoFlame';
  // About 75% across and 75% down the screen at 16:9 with a 75deg FOV.
  mesh.position.set(0.62, -0.38, -1.0);
  mesh.renderOrder = 20;
  mesh.frustumCulled = false; // it is glued to the camera
  camera.add(mesh);

  const lean = new THREE.Vector2();
  const vel = new THREE.Vector2();
  const target = new THREE.Vector2();
  let time = 0;
  let flicker = 1;
  let lastMotion = { localX: 0, localY: 0, localZ: 0, yawDelta: 0, pitchDelta: 0, speed: 0 };

  function update(dt, motion) {
    // Use the real elapsed time for the spring and smoothing. Clamping it
    // would make the flame sluggish whenever rendering drops below 20 fps.
    const elapsed = clamp(dt || 0, 0, 0.25);
    time += elapsed;
    uniforms.uTime.value = time;

    const m = motion || {};
    lastMotion = {
      localX: m.localX || 0,
      localY: m.localY || 0,
      localZ: m.localZ || 0,
      yawDelta: m.yawDelta || 0,
      pitchDelta: m.pitchDelta || 0,
      speed: m.speed || 0
    };
    // Moving right or turning right makes the flame lag to the left.
    target.set(
      clamp(-(m.localX || 0) * 0.025 + (m.yawDelta || 0) * 0.22, -0.16, 0.16),
      clamp(-(m.localY || 0) * 0.025 - (m.pitchDelta || 0) * 0.18, -0.12, 0.12)
    );

    // Damped spring: a soft wobble after a turn instead of an instant tilt.
    // Substeps keep it stable even after a long frame.
    const steps = Math.min(8, Math.max(1, Math.ceil(elapsed * 60)));
    const step = elapsed / steps;
    for (let i = 0; i < steps; i++) {
      vel.x += (target.x - lean.x) * 85 * step;
      vel.y += (target.y - lean.y) * 85 * step;
      vel.multiplyScalar(Math.exp(-11 * step));
      lean.addScaledVector(vel, step);
    }
    uniforms.uLean.value.copy(lean);

    const speed = clamp((m.speed || 0) / 3, 0, 1);
    uniforms.uSpeed.value +=
      (speed - uniforms.uSpeed.value) * (1 - Math.exp(-6 * elapsed));

    // Forward travel (negative local Z) presses the flame down towards the
    // wick; backing up lets it stretch. Smoothed so steps do not pop.
    const depth = clamp(-lastMotion.localZ / 3, -1, 1);
    uniforms.uDepth.value +=
      (depth - uniforms.uDepth.value) * (1 - Math.exp(-8 * elapsed));

    // Three detuned sines look less mechanical than Math.random() per frame.
    flicker =
      0.92 +
      0.055 * Math.sin(time * 11.3) +
      0.04 * Math.sin(time * 23.7 + 1.3) +
      0.025 * Math.sin(time * 41.1 + 0.7);
    uniforms.uIntensity.value = flicker * (0.96 + uniforms.uSpeed.value * 0.08);
  }

  function setVisible(v) {
    mesh.visible = v;
  }

  function dispose() {
    camera.remove(mesh);
    geometry.dispose();
    material.dispose();
  }

  return {
    mesh,
    uniforms,
    update,
    setVisible,
    dispose,
    get flicker() {
      return flicker;
    },
    get motion() {
      return lastMotion;
    },
    get time() {
      return time;
    }
  };
}
