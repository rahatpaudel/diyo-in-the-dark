/**
 * Silent fireworks for the ending sequence.
 *
 * All bursts share one additive Points mesh. Each particle is recycled from a
 * fixed pool, so the show can keep going behind the win screen without
 * allocating anything per frame.
 */
import * as THREE from './vendor/three.module.js';

const BURSTS = 8;
const PER_BURST = 70;
const TOTAL = BURSTS * PER_BURST;
const GRAVITY = 2.6;

const PALETTE = [
  0xff5252,
  0xffd166,
  0x62d2ff,
  0x8aff9a,
  0xd08bff,
  0xff9f43
];

function glowTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.35, 'rgba(255,255,255,0.8)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 64, 64);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export function createFireworks(scene, house) {
  const positions = new Float32Array(TOTAL * 3);
  const colors = new Float32Array(TOTAL * 3);
  const velocities = new Float32Array(TOTAL * 3);
  const baseColors = new Float32Array(TOTAL * 3);
  const life = new Float32Array(TOTAL);
  const maxLife = new Float32Array(TOTAL);

  for (let i = 0; i < TOTAL; i++) {
    positions[i * 3 + 1] = -1000;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.BufferAttribute(positions, 3)
  );
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  const material = new THREE.PointsMaterial({
    size: 0.42,
    map: glowTexture(),
    vertexColors: true,
    transparent: true,
    opacity: 0.95,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    sizeAttenuation: true
  });

  const points = new THREE.Points(geometry, material);
  points.name = 'Fireworks';
  points.frustumCulled = false;
  points.visible = false;
  scene.add(points);

  const colorA = new THREE.Color();
  const colorB = new THREE.Color();

  let active = false;
  let time = 0;
  let nextBurst = 0;
  let cursor = 0;

  function clear() {
    for (let i = 0; i < TOTAL; i++) {
      life[i] = 0;
      positions[i * 3 + 1] = -1000;
      colors[i * 3] = 0;
      colors[i * 3 + 1] = 0;
      colors[i * 3 + 2] = 0;
    }
    geometry.attributes.position.needsUpdate = true;
    geometry.attributes.color.needsUpdate = true;
  }

  function burst() {
    const originX = house.position.x + (Math.random() - 0.5) * 7;
    const originZ = house.position.z + (Math.random() - 0.5) * 5;
    const originY = house.position.y + 7.5 + Math.random() * 4;

    colorA.setHex(PALETTE[Math.floor(Math.random() * PALETTE.length)]);
    colorB.setHex(PALETTE[Math.floor(Math.random() * PALETTE.length)]);

    for (let i = 0; i < PER_BURST; i++) {
      const index = cursor;
      cursor = (cursor + 1) % TOTAL;
      const i3 = index * 3;

      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const speed = 2.4 + Math.random() * 3.4;
      const sinPhi = Math.sin(phi);

      positions[i3] = originX;
      positions[i3 + 1] = originY;
      positions[i3 + 2] = originZ;

      velocities[i3] = Math.cos(theta) * sinPhi * speed;
      velocities[i3 + 1] = Math.cos(phi) * speed;
      velocities[i3 + 2] = Math.sin(theta) * sinPhi * speed;

      const mix = Math.random();
      baseColors[i3] = colorA.r + (colorB.r - colorA.r) * mix;
      baseColors[i3 + 1] = colorA.g + (colorB.g - colorA.g) * mix;
      baseColors[i3 + 2] = colorA.b + (colorB.b - colorA.b) * mix;

      maxLife[index] = 1.2 + Math.random() * 0.9;
      life[index] = maxLife[index];
    }
  }

  function start() {
    active = true;
    time = 0;
    nextBurst = 1.0;
    cursor = 0;
    clear();
    points.visible = true;
  }

  function update(dt) {
    if (!active) return;
    time += dt;

    if (time >= nextBurst) {
      burst();
      nextBurst = time + 0.9 + Math.random() * 0.7;
    }

    for (let i = 0; i < TOTAL; i++) {
      if (life[i] <= 0) continue;
      const i3 = i * 3;

      life[i] -= dt;
      if (life[i] <= 0) {
        life[i] = 0;
        positions[i3 + 1] = -1000;
        colors[i3] = 0;
        colors[i3 + 1] = 0;
        colors[i3 + 2] = 0;
        continue;
      }

      velocities[i3 + 1] -= GRAVITY * dt;
      positions[i3] += velocities[i3] * dt;
      positions[i3 + 1] += velocities[i3 + 1] * dt;
      positions[i3 + 2] += velocities[i3 + 2] * dt;

      const fade = life[i] / maxLife[i];
      const glow = fade * fade;
      colors[i3] = baseColors[i3] * glow;
      colors[i3 + 1] = baseColors[i3 + 1] * glow;
      colors[i3 + 2] = baseColors[i3 + 2] * glow;
    }

    geometry.attributes.position.needsUpdate = true;
    geometry.attributes.color.needsUpdate = true;
  }

  return {
    points,
    start,
    update
  };
}
