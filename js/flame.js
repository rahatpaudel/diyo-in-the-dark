/**
 * The diyo flame that rides in the bottom-right of the view.
 *
 * A small camera-attached quad raymarches through a 3D flame volume: a
 * teardrop-shaped field of animated 3D noise, shaded by temperature and
 * integrated front-to-back with absorption. That gives it real depth — the
 * hot core is inside the volume, the rim is translucent, and the internal
 * structure rotates slowly so it never reads as a painted sprite.
 *
 * One draw call, no textures. The real diya/hand model can replace it later.
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

  float hash3(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.yzx + 33.33);
    return fract((p.x + p.y) * p.z);
  }

  // Tetrahedral interpolation: four hashes instead of eight. Plenty smooth
  // for flame turbulence and roughly half the cost of trilinear noise.
  float noise3(vec3 p) {
    vec3 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash3(i);
    float b = hash3(i + vec3(1,0,0));
    float c = hash3(i + vec3(0,1,0));
    float d = hash3(i + vec3(0,0,1));
    return a + f.x * (b - a) + f.y * (c - a) + f.z * (d - a);
  }

  // Temperature ramp of a small oil flame: deep red rim, orange body,
  // yellow-white core, and a blue root right at the wick.
  vec3 flameColor(float heat, float y) {
    vec3 c = vec3(0.72, 0.08, 0.01);
    c = mix(c, vec3(1.0, 0.40, 0.04), smoothstep(0.10, 0.45, heat));
    c = mix(c, vec3(1.0, 0.78, 0.24), smoothstep(0.42, 0.78, heat));
    c = mix(c, vec3(1.0, 0.97, 0.82), smoothstep(0.78, 1.0, heat));
    c = mix(c, vec3(0.28, 0.52, 1.0),
            (1.0 - smoothstep(0.01, 0.13, y)) * heat * 0.55);
    return c;
  }

  void main() {
    float t = uTime * (1.0 + uSpeed * 0.25);

    // Pad the quad generously on every side. The flame and its ember glow
    // fade out well inside the quad, so there is no clipped straight edge.
    float x = (vUv.x - 0.5);
    float y = (vUv.y - 0.5) * 1.7 + 0.38;

    float h = clamp(y, 0.0, 1.0);
    float sway = sin(t * 1.1 + uSeed) * 0.012 * h;
    float cx = uLean.x * h * h * 1.4 + sway;
    float cy = uLean.y * h * h * 0.5 + uDepth * 0.06 * h;

    // Rotate the sampling volume slowly. With a camera-attached quad this is
    // what lets the eye see around the flame instead of across a flat card.
    float a = t * 0.24 + uLean.x * 2.0;
    float ca = cos(a), sa = sin(a);

    float radius = 0.205 * pow(1.0 - h, 0.58) + 0.012;
    radius *= 0.86 + 0.30 * exp(-pow((h - 0.25) / 0.23, 2.0));

    vec3 acc = vec3(0.0);
    float trans = 1.0;
    const float DS = 0.125;

    for (int i = 0; i < 8; i++) {
      float z = 0.5 - (float(i) + 0.5) * DS;
      vec3 sp = vec3(x - cx, y - cy, z);
      sp.xz = mat2(ca, -sa, sa, ca) * sp.xz;

      float n = 0.72 * noise3(sp * vec3(5.0, 3.2, 5.0) + vec3(uSeed, -t * 0.8, 0.0))
              + 0.28 * noise3(sp * vec3(11.0, 7.0, 11.0) + vec3(3.0, -t * 1.3, 7.0));

      float r = length(sp.xz) / (radius * (0.85 + 0.3 * n));
      float density = 1.0 - smoothstep(0.45, 1.0, r);
      density *= smoothstep(0.0, 0.07, y);
      density *= 1.0 - smoothstep(0.70, 0.98, y);

      float heat = (1.0 - smoothstep(0.0, 1.0, r)) *
                   (1.0 - smoothstep(0.15, 0.85, h));
      heat = clamp(heat + 0.18 * n, 0.0, 1.0);

      float aStep = density * DS * 4.0;
      acc += trans * flameColor(heat, y) * aStep * (0.75 + 0.85 * heat);
      trans *= 1.0 - aStep;
    }

    // A soft ember at the wick grounds the flame without a hard base edge.
    acc += vec3(1.0, 0.34, 0.06) *
           exp(-x * x * 26.0) * exp(-y * y * 70.0) * 0.16;

    gl_FragColor = vec4(acc * uIntensity, uIntensity);
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

  // Extra padding around the volume so nothing is clipped at the quad edges.
  const geometry = new THREE.PlaneGeometry(0.18, 0.30);
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
