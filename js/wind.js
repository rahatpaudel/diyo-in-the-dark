/**
 * Wind gust effect for the stranded sequence.
 *
 * A single instanced mesh draws a few hundred thin, camera-facing ribbons
 * that stream past the player. Each ribbon is aligned to the gust direction
 * and to the camera so it stays visible from any angle. The system is inert
 * (and skipped entirely) until the intensity rises.
 */
import * as THREE from './vendor/three.module.js';

const COUNT = 240;
const RANGE = 11;
const CEILING = 4.2;

const _matrix = new THREE.Matrix4();
const _basisX = new THREE.Vector3();
const _basisY = new THREE.Vector3();
const _basisZ = new THREE.Vector3();
const _scale = new THREE.Vector3();
const _wind = new THREE.Vector3();

function randomBetween(lo, hi) {
  return lo + Math.random() * (hi - lo);
}

export function createWind(scene) {
  const geometry = new THREE.PlaneGeometry(0.62, 0.018);
  const material = new THREE.MeshBasicMaterial({
    color: 0xcfc5b2,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    side: THREE.DoubleSide
  });

  const mesh = new THREE.InstancedMesh(geometry, material, COUNT);
  mesh.name = 'Wind';
  mesh.frustumCulled = false;
  mesh.visible = false;
  scene.add(mesh);

  const particles = [];
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
  }

  let intensity = 0;
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
    const ease = 1 - Math.exp(-dt * (active ? 2.4 : 5.0));
    intensity += (target - intensity) * ease;
    material.opacity = intensity * 0.46;
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

    for (let i = 0; i < particles.length; i++) {
      const particle = particles[i];
      particle.age += dt;

      const sway = Math.sin(particle.age * 4.5 + particle.phase);
      particle.x += (windX * particle.speed + windZ * particle.drift * sway) * dt;
      particle.z += (windZ * particle.speed - windX * particle.drift * sway) * dt;
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
