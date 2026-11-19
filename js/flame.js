/**
 * The diyo flame that rides in the bottom-right of the view.
 *
 * A camera-attached quad ray-marches a small volumetric flame. A teardrop
 * envelope is carved by domain-warped 3D simplex noise, then integrated
 * front-to-back with extinction and a blackbody emission ramp. The result
 * has a hot interior, a translucent orange skin and visible depth instead of
 * a flat painted sprite.
 *
 * One draw call, no textures, no extra lights. The real hand/diya model can
 * replace this module later.
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

  /* ---- Ashima 3D simplex noise (MIT) ---------------------------------- */
  vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec4 permute(vec4 x) { return mod289(((x * 34.0) + 1.0) * x); }
  vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

  float snoise(vec3 v) {
    const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
    const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);

    vec3 i  = floor(v + dot(v, C.yyy));
    vec3 x0 = v - i + dot(i, C.xxx);

    vec3 g = step(x0.yzx, x0.xyz);
    vec3 l = 1.0 - g;
    vec3 i1 = min(g.xyz, l.zxy);
    vec3 i2 = max(g.xyz, l.zxy);

    vec3 x1 = x0 - i1 + C.xxx;
    vec3 x2 = x0 - i2 + C.yyy;
    vec3 x3 = x0 - D.yyy;

    i = mod289(i);
    vec4 p = permute(permute(permute(
               i.z + vec4(0.0, i1.z, i2.z, 1.0))
             + i.y + vec4(0.0, i1.y, i2.y, 1.0))
             + i.x + vec4(0.0, i1.x, i2.x, 1.0));

    float n_ = 0.142857142857;
    vec3 ns = n_ * D.wyz - D.xzx;

    vec4 j = p - 49.0 * floor(p * ns.z * ns.z);

    vec4 x_ = floor(j * ns.z);
    vec4 y_ = floor(j - 7.0 * x_);

    vec4 x = x_ * ns.x + ns.yyyy;
    vec4 y = y_ * ns.x + ns.yyyy;
    vec4 h = 1.0 - abs(x) - abs(y);

    vec4 b0 = vec4(x.xy, y.xy);
    vec4 b1 = vec4(x.zw, y.zw);

    vec4 s0 = floor(b0) * 2.0 + 1.0;
    vec4 s1 = floor(b1) * 2.0 + 1.0;
    vec4 sh = -step(h, vec4(0.0));

    vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
    vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;

    vec3 p0 = vec3(a0.xy, h.x);
    vec3 p1 = vec3(a0.zw, h.y);
    vec3 p2 = vec3(a1.xy, h.z);
    vec3 p3 = vec3(a1.zw, h.w);

    vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
    p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;

    vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
    m = m * m;
    return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
  }

  float fbm(vec3 p) {
    return 0.55 * snoise(p)
         + 0.30 * snoise(p * 2.03 + vec3(11.3, 7.1, 23.7))
         + 0.15 * snoise(p * 4.07 + vec3(3.1, 19.7, 7.3));
  }

  float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }

  /* Blackbody-ish ramp: deep red -> orange -> yellow -> white. */
  vec3 blackbody(float T) {
    vec3 c = vec3(0.06, 0.002, 0.0);
    c = mix(c, vec3(0.70, 0.045, 0.0), smoothstep(0.00, 0.15, T));
    c = mix(c, vec3(1.00, 0.26, 0.010), smoothstep(0.15, 0.35, T));
    c = mix(c, vec3(1.00, 0.55, 0.045), smoothstep(0.35, 0.55, T));
    c = mix(c, vec3(1.00, 0.82, 0.24), smoothstep(0.55, 0.76, T));
    c = mix(c, vec3(1.00, 0.97, 0.80), smoothstep(0.76, 1.00, T));
    return c;
  }

  void main() {
    float t = uTime * (1.0 + uSpeed * 0.06) + uSeed;

    // Padded volume coordinates: x in [-0.45, 0.45], y in [-0.46, 1.29].
    float x = (vUv.x - 0.5) * 0.9;
    float y = (vUv.y - 0.5) * 1.75 + 0.42;
    float H0 = clamp(y, 0.0, 1.0);

    // Pitch shears the upper flame; the base stays planted on the wick.
    float yv = y - uLean.y * H0 * H0 * 0.9;
    float H = clamp(yv, 0.0, 1.0);

    // Spine: a slow living bend plus the player's motion lean. The lean is
    // amplified up the flame so rotations tilt the tip, not the base.
    float spine = uLean.x * H * H * 1.9 + uDepth * 0.030 * H;
    spine += sin(t * 1.15 + H * 1.6) * 0.022 * H;
    spine += sin(t * 2.45 - H * 2.6 + 1.7) * 0.008 * H;

    // Teardrop half-width: pinched at the wick, fullest just above it, then
    // closing in a rounded point instead of a needle.
    float rise = smoothstep(0.0, 0.22, H);
    float fall = 1.0 - smoothstep(0.22, 1.0, H);
    float R = 0.155 * pow(rise, 0.55) * pow(fall, 0.85) + 0.003;

    // Mild dither only: full per-pixel jitter reads as grain on a flame this
    // small.
    float jitter = 0.5 + (hash12(gl_FragCoord.xy) - 0.5) * 0.5;

    vec3 acc = vec3(0.0);
    float trans = 1.0;
    const int STEPS = 24;
    const float DZ = 1.1 / 24.0;

    for (int i = 0; i < STEPS; i++) {
      float z = 0.55 - (float(i) + jitter) * DZ;

      float rx = (x - spine) / R;
      float rz = z / R;

      // The noise field is much coarser along the ray than in the visible
      // plane, so the volume integrates smoothly instead of sparkling.
      vec3 np = vec3(rx * 0.95 - uLean.x * 0.5,
                     H * 2.15 - t * 0.80,
                     z / (R * 2.4));
      vec3 w = vec3(
        snoise(np * 1.30 + vec3(0.0, 0.0, 2.0)),
        snoise(np * 1.30 + vec3(4.7, 1.2, 3.1)),
        snoise(np * 1.30 + vec3(8.3, 3.7, 6.2))
      );
      float n = fbm(np + w * 0.26) * 0.5 + 0.5;

      // The noise pushes the silhouette itself, so the outline licks and
      // curls instead of staying a perfect teardrop.
      float rmod = 0.86 + 0.34 * (n - 0.5) * 2.0;
      float rad = sqrt(rx * rx + rz * rz) / rmod;

      float env = 1.0 - smoothstep(0.36, 1.05, rad);
      float body = env * (0.32 + 1.08 * n);
      body *= smoothstep(0.0, 0.12, yv);
      body *= 1.0 - smoothstep(0.80, 1.08, yv);
      body = clamp(body, 0.0, 1.0);

      // Hottest just above the wick; the tip still glows dull orange.
      float core = 1.0 - smoothstep(0.0, 0.90, rad);
      float heat = core * (1.0 - smoothstep(0.12, 0.98, H));
      heat = clamp(pow(max(heat, 0.0), 0.85) * 1.18 + 0.12
                   + 0.09 * (n - 0.5), 0.0, 1.0);

      vec3 emit = blackbody(heat);
      // Blue root where the wick feeds the flame.
      float blue = (1.0 - smoothstep(0.0, 0.11, yv))
                 * (1.0 - smoothstep(0.0, 0.60, rad));
      emit = mix(emit, vec3(0.08, 0.24, 1.0) * 1.4, blue * 0.60);

      float sigma = body * 2.6;
      float aStep = 1.0 - exp(-sigma * DZ);
      acc += trans * emit * (1.0 + 3.0 * heat) * body * DZ * 2.2;
      trans *= 1.0 - aStep;
    }

    gl_FragColor = vec4(acc * uIntensity, 1.0);
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

  // Taller than the plume so the base can fade out inside the quad.
  const geometry = new THREE.PlaneGeometry(0.26, 0.36);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'DiyoFlame';
  mesh.position.set(0.60, -0.40, -1.0); // ~75% across, ~80% down at 16:9
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
    // Real elapsed time keeps the response identical at any frame rate.
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

    // Turn and pitch tilt the flame clearly; walking only nudges it.
    target.set(
      clamp(-lastMotion.localX * 0.006 + lastMotion.yawDelta * 0.35, -0.09, 0.09),
      clamp(-lastMotion.localY * 0.006 - lastMotion.pitchDelta * 0.22, -0.075, 0.075)
    );

    // Heavily damped spring with substeps, stable across long frames.
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

    const depth = clamp(-lastMotion.localZ / 3, -1, 1);
    uniforms.uDepth.value +=
      (depth - uniforms.uDepth.value) * (1 - Math.exp(-5 * elapsed));

    // Gentle swell rather than a strobe.
    flicker =
      0.98 +
      0.011 * Math.sin(time * 2.7) +
      0.006 * Math.sin(time * 5.9 + 1.1) +
      0.004 * Math.sin(time * 0.9 + 0.4);
    uniforms.uIntensity.value = flicker * 0.995;
  }

  function setVisible(v) {
    mesh.visible = v;
  }

  /**
   * Place the flame so its wick (volume y = 0) sits exactly at a point in
   * camera space. The shader's volume origin is 26% up the quad, which is
   * why the mesh itself is offset upward by that fraction of its height.
   */
  function setWickPosition(x, y, z, scale = 1) {
    const s = scale > 0 ? scale : 1;
    mesh.scale.setScalar(s);
    mesh.position.set(x, y + 0.0864 * s, z);
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
    setWickPosition,
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
