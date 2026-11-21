/**
 * Wind gust effect for the stranded sequence.
 *
 * One instanced mesh draws a few hundred camera-facing ribbons. The ribbons
 * are bent into a travelling S-curve in the vertex shader, so they read as
 * wind rather than straight streaks, and both the gust speed and the wave
 * amplitude ramp up as the storm builds.
 */
import * as THREE from './vendor/three.module.js';

const COUNT = 240;
const RANGE = 11;
const CEILING = 4.2;
const RIBBON_LENGTH = 0.82;

const _matrix = new THREE.Matrix4();
const _basisX = new THREE.Vector3();
const _basisY = new THREE.Vector3();
const _basisZ = new THREE.Vector3();
const _scale = new THREE.Vector3();
const _wind = new THREE.Vector3();

const VERT = `
  uniform float uTime;
  uniform float uWave;
  attribute float aPhase;
  attribute float aAmp;
  varying float vEdge;

  void main() {
    vec3 transformed = position;
    float edge = abs(position.x) / ${(RIBBON_LENGTH / 2).toFixed(3)};
    float wave = sin(
      position.x * (7.0 + 5.0 * uWave) +
      uTime * (4.0 + 7.0 * uWave) +
      aPhase
    );
    transformed.y +=
      wave * aAmp * (0.35 + 0.65 * edge) * (0.5 + 0.8 * uWave);
    vEdge = 1.0 - smoothstep(0.55, 1.0, edge);
    #include <project_vertex>
  }
`;

const FRAG = `
  uniform vec3 uColor;
  uniform float uOpacity;
  varying float vEdge;

  void main() {
    gl_FragColor = vec4(uColor, uOpacity * vEdge);
  }
`;

function randomBetween(lo, hi) {
  return lo + Math.random() * (hi - lo);
}

export function createWind(scene) {
  const particles = [];
  const phases = new Float32Array(COUNT);
  const amplitudes = new Float32Array(COUNT);
  for (let i = 0; i < COUNT; i++) {
    particles.push({
      x: 0,
      y: 0,
      z: 0,
      speed: randomBetween(7, 15),
      length: randomBetween(0.55, 1.6),
      phase: randomBetween(0, Math.PI * 2),
      drift: randomBetween(-0.6, 0.6),
      age: randomBetween(0, 4)
    });
    phases[i] = randomBetween(0, Math.PI * 2);
    amplitudes[i] = randomBetween(0.025, 0.085);
  }

  const geometry = new THREE.PlaneGeometry(
    RIBBON_LENGTH,
    0.022,
    18,
    1
  );
  geometry.setAttribute(
    'aPhase',
    new THREE.InstancedBufferAttribute(phases, 1)
  );
  geometry.setAttribute(
    'aAmp',
    new THREE.InstancedBufferAttribute(amplitudes, 1)
  );

  const uniforms = {
    uTime: { value: 0 },
    uWave: { value: 0 },
    uOpacity: { value: 0 },
    uColor: { value: new THREE.Color(0xcfc5b2) }
  };
  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide
  });

  const mesh = new THREE.InstancedMesh(geometry, material, COUNT);
  mesh.name = 'Wind';
  mesh.frustumCulled = false;
  mesh.visible = false;
  scene.add(mesh);

  let intensity = 0;
  let gust = 0;
  let time = 0;
  let spawned = false;

  function respawn(particle, camera, windX, windZ, initial) {
    const angle = Math.random() * Math.PI * 2;
    const radius = initial
      ? randomBetween(1.5, RANGE)
      : randomBetween(RANGE * 0.7, RANGE);
    particle.x = camera.x + Math.cos(angle) * radius - windX * (initial ? 0 : 4);
    particle.z = camera.z + Math.sin(angle) * radius - windZ * (initial ? 0 : 4);
    particle.y = camera.y - 1.3 + randomBetween(0, CEILING);
    particle.age = randomBetween(0, 3);
    particle.phase = randomBetween(0, Math.PI * 2);
  }

  function update(dt, cameraPosition, active) {
    time += dt;
    const target = active ? 1 : 0;

    // The gust takes several seconds to arrive, and the streaks themselves
    // start as a slow drift before the full speed comes up.
    intensity +=
      (target - intensity) * (1 - Math.exp(-dt * (active ? 1.0 : 2.2)));
    gust +=
      (target - gust) * (1 - Math.exp(-dt * (active ? 0.85 : 2.2)));

    uniforms.uTime.value = time;
    uniforms.uWave.value = gust;
    uniforms.uOpacity.value = intensity * 0.46;
    mesh.visible = intensity > 0.01;
    if (!mesh.visible) return;

    const windAngle = 0.72 + Math.sin(time * 0.31) * 0.22;
    const windX = Math.cos(windAngle);
    const windZ = Math.sin(windAngle);
    _wind.set(windX, 0, windZ);

    if (!spawned) {
      spawned = true;
      for (const particle of particles) {
        respawn(particle, cameraPosition, windX, windZ, true);
      }
    }

    const speedScale = 0.15 + 0.85 * gust;

    for (let i = 0; i < particles.length; i++) {
      const particle = particles[i];
      particle.age += dt;

      const sway = Math.sin(particle.age * 4.5 + particle.phase);
      particle.x +=
        (windX * particle.speed * speedScale +
          windZ * particle.drift * sway) * dt;
      particle.z +=
        (windZ * particle.speed * speedScale -
          windX * particle.drift * sway) * dt;
      particle.y += (sway * 0.35 + 0.12) * dt;

      const dx = particle.x - cameraPosition.x;
      const dz = particle.z - cameraPosition.z;
      const dy = particle.y - cameraPosition.y;

      if (
        dx * dx + dz * dz > RANGE * RANGE ||
        dy > CEILING + 1.2 ||
        dy < -2.4
      ) {
        respawn(particle, cameraPosition, windX, windZ, false);
        continue;
      }

      _basisZ.set(-dx, -dy, -dz);
      if (_basisZ.lengthSq() < 1e-6) _basisZ.set(0, 0, 1);
      _basisZ.normalize();

      _basisX.copy(_wind);
      _basisX.addScaledVector(_basisZ, -_basisX.dot(_basisZ));
      if (_basisX.lengthSq() < 1e-6) _basisX.set(1, 0, 0);
      _basisX.normalize();

      _basisY.crossVectors(_basisZ, _basisX).normalize();

      _matrix.makeBasis(_basisX, _basisY, _basisZ);
      _matrix.scale(_scale.set(particle.length, 1, 1));
      _matrix.setPosition(particle.x, particle.y, particle.z);
      mesh.setMatrixAt(i, _matrix);
    }

    mesh.instanceMatrix.needsUpdate = true;
  }

  return {
    mesh,
    update
  };
}
