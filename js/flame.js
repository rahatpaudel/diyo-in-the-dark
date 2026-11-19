/**
 * The diyo flame that rides in the bottom-right of the view.
 *
 * A single camera-attached billboard with a procedural GLSL flame: a short,
 * rounded teardrop with a white-hot core, an orange rim and a blue root at the
 * wick. No textures and one draw call, so it is cheap enough to stay on screen
 * at all times. The real diya/hand model can replace this billboard later.
 *
 * Motion is deliberately gentle. A real oil flame leans and settles rather
 * than snapping: strafing and turning feed a heavily damped spring, forward
 * travel presses it toward the wick, and speed only quickens the turbulence
 * slightly. The slow swell is shared with the gameplay spotlight so the world
 * light and the visible flame breathe together.
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

  // Just two smooth octaves. Finer octaves read as buzzing, not as a flame.
  float noise2(vec2 p) {
    return 0.68 * vnoise(p) + 0.32 * vnoise(p * 2.03 + 13.7);
  }

  void main() {
    float t = uTime * (1.0 + uSpeed * 0.35);
    vec2 p = vec2(vUv.x - 0.5, vUv.y);
    float h = clamp(p.y, 0.0, 1.0);

    // Walking forward presses the flame a little toward the wick.
    p.y += uDepth * 0.05 * h;

    // One slow, small sway plus the motion lean. Both ease toward the tip so
    // the base stays planted on the wick.
    float sway = sin(t * 1.15 + h * 2.2 + uSeed) * 0.010 * h;
    p.x -= uLean.x * h * h * 0.9 + sway;
    p.y -= uLean.y * h * h * 0.18;

    // Turbulence drifts upward slowly, so the outline undulates instead of
    // jittering frame to frame.
    float n = noise2(vec2(p.x * 4.0 + uSeed, h * 2.2 - t * 0.55));
    float wobble = (n - 0.5) * 0.09 * h;
    float dx = abs(p.x - wobble);

    float taper = pow(1.0 - h, 0.55);
    float radius = 0.16 * taper + 0.012;
    radius *= 0.85 + 0.30 * exp(-pow((h - 0.26) / 0.24, 2.0));
    radius *= 0.93 + 0.14 * n;

    float shape = 1.0 - smoothstep(radius * 0.65, radius, dx);
    shape *= smoothstep(0.0, 0.05, h);
    shape *= 1.0 - smoothstep(0.68, 0.96, h);
    shape *= 0.90 + 0.14 * noise2(vec2(p.x * 5.0, h * 2.6 - t * 0.7));
    shape = clamp(shape, 0.0, 1.0);

    float core = 1.0 - smoothstep(0.0, radius * 0.55, dx);
    core *= 1.0 - smoothstep(0.30, 0.78, h);

    vec3 outer = vec3(1.0, 0.30, 0.035);
    vec3 mid   = vec3(1.0, 0.68, 0.16);
    vec3 hot   = vec3(1.0, 0.95, 0.72);
    vec3 col = mix(outer, mid, core);
    col = mix(col, hot, pow(core, 2.6) * 0.85);

    // A hint of blue right at the wick, like a real oil-lamp flame.
    col = mix(col, vec3(0.32, 0.55, 1.0),
              (1.0 - smoothstep(0.01, 0.13, h)) * core * 0.55);

    float halo = exp(-dx * dx / 0.045) * exp(-pow((h - 0.30) / 0.36, 2.0));
    col += vec3(1.0, 0.28, 0.05) * halo * 0.22;

    float alpha = clamp(shape + halo * 0.18, 0.0, 1.0) * uIntensity;
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

  // Short and rounded, roughly twice as tall as it is wide. The old plane
  // was 0.34 tall and read as a long, thin ribbon.
  const geometry = new THREE.PlaneGeometry(0.28, 0.20);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'DiyoFlame';
  mesh.position.set(0.62, -0.40, -1.0); // ~75% across, ~80% down at 16:9
  mesh.renderOrder = 20;
  mesh.frustumCulled = false; // it is glued to the camera
  camera.add(mesh);

  const lean = new THREE.Vector2();
  const vel = new THREE.Vector2();
  const target = new THREE.Vector2();
  const lastMotion = { localX: 0, localY: 0, localZ: 0, yawDelta: 0, pitchDelta: 0, speed: 0 };
  let time = 0;
  let flicker = 1;

  function update(dt, motion) {
    // Use the real elapsed time for the spring and smoothing. Clamping it
    // would make the flame sluggish whenever rendering drops below 20 fps.
    const elapsed = clamp(dt || 0, 0, 0.25);
    time += elapsed;
    uniforms.uTime.value = time;

    const m = motion || {};
    lastMotion.localX = m.localX || 0;
    lastMotion.localY = m.localY || 0;
    lastMotion.localZ = m.localZ || 0;
    lastMotion.yawDelta = m.yawDelta || 0;
    lastMotion.pitchDelta = m.pitchDelta || 0;
    lastMotion.speed = m.speed || 0;

    // Small targets: a lamp flame sways, it does not whip around.
    target.set(
      clamp(-lastMotion.localX * 0.012 + lastMotion.yawDelta * 0.09, -0.06, 0.06),
      clamp(-lastMotion.localY * 0.012 - lastMotion.pitchDelta * 0.07, -0.05, 0.05)
    );

    // Heavily damped spring: leans into the motion, then settles smoothly.
    // Substeps keep it stable even after a long frame.
    const steps = Math.min(8, Math.max(1, Math.ceil(elapsed * 60)));
    const step = elapsed / steps;
    for (let i = 0; i < steps; i++) {
      vel.x += (target.x - lean.x) * 45 * step;
      vel.y += (target.y - lean.y) * 45 * step;
      vel.multiplyScalar(Math.exp(-10 * step));
      lean.addScaledVector(vel, step);
    }
    uniforms.uLean.value.copy(lean);

    const speed = clamp(lastMotion.speed / 3, 0, 1);
    uniforms.uSpeed.value +=
      (speed - uniforms.uSpeed.value) * (1 - Math.exp(-4 * elapsed));

    // Forward travel compresses; backing up lets it stretch.
    const depth = clamp(-lastMotion.localZ / 3, -1, 1);
    uniforms.uDepth.value +=
      (depth - uniforms.uDepth.value) * (1 - Math.exp(-5 * elapsed));

    // A slow swell instead of fast sine jitter. Roughly 6% brightness range,
    // so the light feels alive without strobing.
    flicker =
      0.97 +
      0.018 * Math.sin(time * 2.7) +
      0.012 * Math.sin(time * 5.9 + 1.1) +
      0.010 * Math.sin(time * 0.9 + 0.4);
    uniforms.uIntensity.value = flicker * (0.98 + uniforms.uSpeed.value * 0.03);
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
