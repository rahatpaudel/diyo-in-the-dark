/**
 * The first riddle site: a large carved sign in the fork and one engraved
 * stone on each branch.
 *
 * Geometry and textures are generated in code. The only external art is the
 * four silhouette SVGs in icons/, which are rasterised once and carved with a
 * recessed fill plus a lit lower lip, so they read as cut into the material
 * instead of pasted on top of it.
 */
import * as THREE from './vendor/three.module.js';
import { heightAt } from './terrain.js';
import {
  nearestPath,
  PATH_HALF_WIDTH,
  RIDDLE_SITES
} from './path.js';

const ICON_SIZE = 512;
const SIGN_W = 1.5;
const SIGN_H = 0.95;
const SIGN_TEX_W = 1536;
const SIGN_TEX_H = Math.round((SIGN_TEX_W * SIGN_H) / SIGN_W);
const STONE_TEX_W = 768;
const STONE_TEX_H = 900;

const SIGN_CARVE = {
  recess: '#3a2410',
  highlight: '#ddb074',
  shadow: '#1c1006'
};

const STONE_CARVE = {
  recess: '#2b2822',
  highlight: '#a99c86',
  shadow: '#13110d'
};

/* ------------------------------------------------------------------ */
/*  Icon loading + carved-symbol drawing                              */
/* ------------------------------------------------------------------ */
const tintCache = new WeakMap();

async function loadIcon(name) {
  const res = await fetch('icons/' + name + '.svg');
  if (!res.ok) throw new Error('icons/' + name + '.svg returned ' + res.status);
  const source = await res.text();
  const image = new Image();
  const decoded = new Promise((resolve, reject) => {
    image.onload = resolve;
    image.onerror = () => reject(new Error('Could not decode ' + name + '.svg'));
  });
  image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(source);
  await decoded;
  return image;
}

/** Normalise any icon into a square alpha canvas. */
function rasterize(image, size = ICON_SIZE) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const w = image.naturalWidth || image.width || size;
  const h = image.naturalHeight || image.height || size;
  const scale = Math.min(size / w, size / h);
  ctx.drawImage(
    image,
    (size - w * scale) / 2,
    (size - h * scale) / 2,
    w * scale,
    h * scale
  );
  return canvas;
}

/** Fill the opaque part of a silhouette with one colour. */
function tint(source, color) {
  let colors = tintCache.get(source);
  if (!colors) {
    colors = new Map();
    tintCache.set(source, colors);
  }
  if (colors.has(color)) return colors.get(color);

  const canvas = document.createElement('canvas');
  canvas.width = source.width;
  canvas.height = source.height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(source, 0, 0);
  ctx.globalCompositeOperation = 'source-in';
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  colors.set(color, canvas);
  return canvas;
}

function glyphFromText(text, font) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = ICON_SIZE;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, ICON_SIZE / 2, ICON_SIZE / 2 + ICON_SIZE * 0.04);
  return canvas;
}

/**
 * Draw a silhouette as a recessed groove: shadow on the top lip, light on the
 * bottom lip, then the dark interior. `depth` is in texture pixels.
 */
function drawCarvedGlyph(ctx, glyph, cx, cy, box, palette, depth) {
  const scale = Math.min(box / glyph.width, box / glyph.height);
  const w = glyph.width * scale;
  const h = glyph.height * scale;
  const x = cx - w / 2;
  const y = cy - h / 2;
  const d = Math.max(2, Math.round(depth));

  ctx.save();
  ctx.globalAlpha = 0.55;
  ctx.drawImage(tint(glyph, palette.shadow), x, y - d * 0.7, w, h);
  ctx.globalAlpha = 0.9;
  ctx.drawImage(tint(glyph, palette.highlight), x, y + d, w, h);
  ctx.globalAlpha = 1;
  ctx.drawImage(tint(glyph, palette.recess), x, y, w, h);
  ctx.restore();
}

/** Painted numerals: readable at a glance, still seated in a dark groove. */
function drawPaintedText(ctx, text, cx, cy, font, fill, shadow) {
  ctx.save();
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = shadow;
  ctx.fillText(text, cx, cy + 8);
  ctx.fillStyle = fill;
  ctx.fillText(text, cx, cy);
  ctx.restore();
}

/** Same recessed treatment as the icons, for carved words. */
function drawCarvedText(ctx, text, cx, cy, font, palette, depth) {
  const d = Math.max(2, Math.round(depth));
  ctx.save();
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = palette.shadow;
  ctx.fillText(text, cx, cy - d * 0.7);
  ctx.fillStyle = palette.highlight;
  ctx.fillText(text, cx, cy + d);
  ctx.fillStyle = palette.recess;
  ctx.fillText(text, cx, cy);
  ctx.restore();
}

/* ------------------------------------------------------------------ */
/*  Sign texture                                                      */
/* ------------------------------------------------------------------ */
function deterministicRandom(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function carveLine(ctx, x0, y0, x1, y1, width) {
  ctx.save();
  ctx.lineCap = 'round';
  ctx.strokeStyle = 'rgba(28,16,6,0.9)';
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(226,176,116,0.38)';
  ctx.lineWidth = Math.max(2, width * 0.32);
  ctx.beginPath();
  ctx.moveTo(x0, y0 + width * 0.7);
  ctx.lineTo(x1, y1 + width * 0.7);
  ctx.stroke();
  ctx.restore();
}

function newSignCanvas() {
  const canvas = document.createElement('canvas');
  canvas.width = SIGN_TEX_W;
  canvas.height = SIGN_TEX_H;
  return canvas;
}

/** Weathered planks, seams, and the recessed border shared by both signs. */
function paintPlank(ctx) {
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  const rand = deterministicRandom(0x5eed);

  const planks = 3;
  const plankW = W / planks;
  for (let i = 0; i < planks; i++) {
    ctx.fillStyle = i % 2 === 0 ? '#83552d' : '#79502a';
    ctx.fillRect(i * plankW, 0, plankW + 1, H);
  }

  for (let i = 0; i < 190; i++) {
    const x = rand() * W;
    const y = rand() * H;
    const len = 60 + rand() * 420;
    const light = rand() > 0.55;
    ctx.strokeStyle = light
      ? 'rgba(214,162,102,' + (0.04 + rand() * 0.06).toFixed(3) + ')'
      : 'rgba(52,30,13,' + (0.05 + rand() * 0.08).toFixed(3) + ')';
    ctx.lineWidth = 1.5 + rand() * 4;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.bezierCurveTo(
      x + 10 * rand(),
      y + len * 0.33,
      x - 12 * rand(),
      y + len * 0.66,
      x + 4 * rand(),
      y + len
    );
    ctx.stroke();
  }

  for (let i = 1; i < planks; i++) {
    carveLine(ctx, i * plankW, 0, i * plankW, H, 9);
  }

  const pad = 30;
  ctx.strokeStyle = 'rgba(30,17,7,0.95)';
  ctx.lineWidth = 8;
  ctx.strokeRect(pad, pad, W - pad * 2, H - pad * 2);
  ctx.strokeStyle = 'rgba(232,183,122,0.4)';
  ctx.lineWidth = 3;
  ctx.strokeRect(pad + 6, pad + 6, W - (pad + 6) * 2, H - (pad + 6) * 2);

  return rand;
}

function finishSign(ctx, rand) {
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  for (let i = 0; i < 1400; i++) {
    ctx.fillStyle =
      rand() > 0.5 ? 'rgba(255,225,180,0.03)' : 'rgba(20,10,4,0.05)';
    ctx.fillRect(rand() * W, rand() * H, 1 + rand() * 2, 1 + rand() * 2);
  }
}

/** Shrink a font until the line fits. Returns the canvas font string. */
function fitFont(ctx, text, family, weight, startSize, maxWidth) {
  let size = startSize;
  do {
    ctx.font = weight + ' ' + size + 'px ' + family;
    if (ctx.measureText(text).width <= maxWidth) break;
    size -= 4;
  } while (size > 24);
  return ctx.font;
}

/** First riddle: १ २ ३ over crow, ?, cow. */
function makeGridSignTexture(glyphs) {
  const canvas = newSignCanvas();
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  const rand = paintPlank(ctx);
  const pad = 30;

  const colX = [W / 6, W / 2, (W * 5) / 6];
  const rowLineY = Math.round(H * 0.36);
  carveLine(ctx, pad, rowLineY, W - pad, rowLineY, 7);
  carveLine(ctx, W / 3, pad, W / 3, H - pad, 7);
  carveLine(ctx, (W * 2) / 3, pad, (W * 2) / 3, H - pad, 7);

  const numeralFont =
    '700 196px "Riddle Devanagari", "Noto Sans Devanagari", serif';
  const numerals = ['१', '२', '३'];
  for (let i = 0; i < 3; i++) {
    drawPaintedText(
      ctx,
      numerals[i],
      colX[i],
      Math.round(H * 0.19),
      numeralFont,
      '#f0d3a0',
      '#241306'
    );
  }

  const iconCy = Math.round(H * 0.69);
  const iconBox = Math.round(H * 0.43);
  drawCarvedGlyph(ctx, glyphs.crow, colX[0], iconCy, iconBox, SIGN_CARVE, 5);
  drawCarvedGlyph(ctx, glyphs.question, colX[1], iconCy, iconBox, SIGN_CARVE, 5);
  drawCarvedGlyph(ctx, glyphs.cow, colX[2], iconCy, iconBox, SIGN_CARVE, 5);

  finishSign(ctx, rand);
  return canvas;
}

/** Later riddles: one line of Nepali over one line of English. */
function makeTextSignTexture(site) {
  const canvas = newSignCanvas();
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  const rand = paintPlank(ctx);
  const maxWidth = W - 120;

  const nepaliFamily =
    '"Riddle Devanagari", "Noto Sans Devanagari", serif';
  const nepaliFont = fitFont(ctx, site.titleNe, nepaliFamily, '700', 260, maxWidth);
  drawPaintedText(
    ctx,
    site.titleNe,
    W / 2,
    Math.round(H * 0.35),
    nepaliFont,
    '#f0d3a0',
    '#241306'
  );

  const englishFamily = 'Georgia, "Times New Roman", serif';
  const englishFont = fitFont(ctx, site.subtitle, englishFamily, '600', 140, maxWidth);
  drawPaintedText(
    ctx,
    site.subtitle,
    W / 2,
    Math.round(H * 0.7),
    englishFont,
    '#e6c592',
    '#241306'
  );

  finishSign(ctx, rand);
  return canvas;
}

/* ------------------------------------------------------------------ */
/*  Stone texture                                                     */
/* ------------------------------------------------------------------ */
function makeStoneTexture(content) {
  const canvas = document.createElement('canvas');
  canvas.width = STONE_TEX_W;
  canvas.height = STONE_TEX_H;
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;

  // Carved border. The panel is transparent; only the marks are drawn.
  const pad = 62;
  ctx.strokeStyle = 'rgba(24,22,18,0.9)';
  ctx.lineWidth = 13;
  ctx.strokeRect(pad, pad, W - pad * 2, H - pad * 2);
  ctx.strokeStyle = 'rgba(196,184,162,0.32)';
  ctx.lineWidth = 5;
  ctx.strokeRect(pad + 8, pad + 8, W - (pad + 8) * 2, H - (pad + 8) * 2);

  if (content.glyph) {
    drawCarvedGlyph(
      ctx,
      content.glyph,
      W / 2,
      H / 2 + 6,
      W * 0.66,
      STONE_CARVE,
      6
    );
  } else {
    const maxWidth = W * 0.78;
    const nepaliFamily =
      '"Riddle Devanagari", "Noto Sans Devanagari", serif';
    const nepaliFont = fitFont(ctx, content.ne, nepaliFamily, '700', 210, maxWidth);
    drawCarvedText(
      ctx,
      content.ne,
      W / 2,
      Math.round(H * 0.35),
      nepaliFont,
      STONE_CARVE,
      6
    );

    const englishFamily = 'Georgia, "Times New Roman", serif';
    const englishFont = fitFont(ctx, content.en, englishFamily, '600', 110, maxWidth);
    drawCarvedText(
      ctx,
      content.en,
      W / 2,
      Math.round(H * 0.68),
      englishFont,
      STONE_CARVE,
      5
    );
  }

  return canvas;
}

/* ------------------------------------------------------------------ */
/*  Meshes                                                            */
/* ------------------------------------------------------------------ */
function canvasTexture(canvas, renderer, srgb) {
  const texture = new THREE.CanvasTexture(canvas);
  if (srgb) texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = renderer && renderer.capabilities
    ? Math.min(8, renderer.capabilities.getMaxAnisotropy())
    : 1;
  texture.needsUpdate = true;
  return texture;
}

function yawToward(x, z, target) {
  return Math.atan2(target.x - x, target.z - z);
}

function buildSign(faceCanvas, renderer) {
  const group = new THREE.Group();
  group.name = 'RiddleSign';

  const wood = new THREE.MeshStandardMaterial({
    color: 0x3c2616,
    roughness: 0.92,
    metalness: 0
  });
  const plank = new THREE.MeshStandardMaterial({
    color: 0x4b2f1b,
    roughness: 0.9,
    metalness: 0
  });
  const stone = new THREE.MeshStandardMaterial({
    color: 0x585148,
    roughness: 1,
    metalness: 0,
    flatShading: true
  });

  // A single post carries one small plank. No frame, no board, no sill.
  const postH = 2.45;
  const post = new THREE.Mesh(new THREE.BoxGeometry(0.16, postH, 0.16), wood);
  post.position.set(0, postH / 2, -0.16);
  post.castShadow = true;
  post.receiveShadow = true;
  group.add(post);

  const foot = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.3, 0.6), stone);
  foot.position.set(0, 0.15, -0.14);
  foot.castShadow = true;
  foot.receiveShadow = true;
  group.add(foot);

  const backing = new THREE.Mesh(
    new THREE.BoxGeometry(SIGN_W + 0.1, SIGN_H + 0.1, 0.09),
    plank
  );
  backing.position.set(0, 1.85, 0);
  backing.castShadow = true;
  backing.receiveShadow = true;
  group.add(backing);

  const faceTexture = canvasTexture(faceCanvas, renderer, true);
  const faceMaterial = new THREE.MeshStandardMaterial({
    map: faceTexture,
    roughness: 0.86,
    metalness: 0,
    emissive: 0xffffff,
    emissiveMap: faceTexture,
    emissiveIntensity: 0.16
  });
  const face = new THREE.Mesh(
    new THREE.PlaneGeometry(SIGN_W, SIGN_H),
    faceMaterial
  );
  face.position.set(0, 1.85, 0.051);
  group.add(face);

  return group;
}

function buildStone(content, renderer) {
  const group = new THREE.Group();
  group.name = 'RiddleStone';

  const outline = [
    [-0.76, -0.94],
    [0.7, -0.95],
    [0.8, -0.34],
    [0.76, 0.35],
    [0.52, 0.88],
    [0.06, 0.96],
    [-0.44, 0.9],
    [-0.79, 0.46],
    [-0.82, -0.3]
  ];
  const shape = new THREE.Shape();
  outline.forEach(([x, y], i) => {
    if (i === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  });
  shape.closePath();

  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: 0.34,
    bevelEnabled: true,
    bevelSize: 0.06,
    bevelThickness: 0.06,
    bevelSegments: 1,
    curveSegments: 1
  });
  geometry.computeBoundingBox();
  const bounds = geometry.boundingBox;
  geometry.translate(
    -(bounds.min.x + bounds.max.x) / 2,
    -bounds.min.y,
    -(bounds.min.z + bounds.max.z) / 2
  );
  geometry.computeBoundingBox();
  geometry.computeVertexNormals();

  const rockMaterial = new THREE.MeshStandardMaterial({
    color: 0x655e52,
    roughness: 0.98,
    metalness: 0,
    flatShading: true
  });
  const rock = new THREE.Mesh(geometry, rockMaterial);
  rock.castShadow = true;
  rock.receiveShadow = true;
  group.add(rock);

  const faceTexture = canvasTexture(makeStoneTexture(content), renderer, true);
  const faceMaterial = new THREE.MeshStandardMaterial({
    map: faceTexture,
    transparent: true,
    depthWrite: false,
    roughness: 0.95,
    metalness: 0,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2
  });
  const face = new THREE.Mesh(new THREE.PlaneGeometry(0.98, 1.15), faceMaterial);
  face.position.set(
    0,
    geometry.boundingBox.max.y * 0.5,
    geometry.boundingBox.max.z + 0.006
  );
  face.renderOrder = 1;
  group.add(face);

  return group;
}

/* ------------------------------------------------------------------ */
/*  Public builder                                                    */
/* ------------------------------------------------------------------ */
export async function buildRiddleSign(scene, renderer) {
  await document.fonts.load('700 196px "Riddle Devanagari"');

  const [crow, cow, dog, horse, owl] = await Promise.all([
    loadIcon('crow'),
    loadIcon('cow'),
    loadIcon('dog'),
    loadIcon('horse'),
    loadIcon('owl')
  ]);

  const glyphs = {
    crow: rasterize(crow),
    cow: rasterize(cow),
    dog: rasterize(dog),
    horse: rasterize(horse),
    owl: rasterize(owl),
    question: glyphFromText('?', '700 430px Georgia, "Times New Roman", serif')
  };

  const group = new THREE.Group();
  group.name = 'RiddleSites';

  for (const site of RIDDLE_SITES) {
    const faceCanvas =
      site.kind === 'grid'
        ? makeGridSignTexture(glyphs)
        : makeTextSignTexture(site);

    const sign = buildSign(faceCanvas, renderer);
    sign.name = 'RiddleSign-' + site.id;
    sign.position.set(
      site.sign.x,
      heightAt(site.sign.x, site.sign.z) - 0.14,
      site.sign.z
    );
    sign.rotation.y = yawToward(
      site.sign.x,
      site.sign.z,
      site.facing || site.approach
    );
    group.add(sign);

    for (const stoneSite of site.stones) {
      const content = stoneSite.icon
        ? { glyph: glyphs[stoneSite.icon] }
        : stoneSite.mark
          ? {
              glyph: glyphFromText(
                stoneSite.mark,
                '700 360px Georgia, "Times New Roman", serif'
              )
            }
          : { ne: stoneSite.ne, en: stoneSite.en };
      const stone = buildStone(content, renderer);
      stone.name =
        'RiddleStone-' +
        (stoneSite.icon || stoneSite.mark || stoneSite.en);
      stone.position.set(
        stoneSite.x,
        heightAt(stoneSite.x, stoneSite.z) - 0.12,
        stoneSite.z
      );
      stone.rotation.y = yawToward(
        stoneSite.x,
        stoneSite.z,
        site.facing || site.approach
      );
      group.add(stone);
    }

    // A quiet guard against future path changes putting a prop on the trail.
    for (const prop of [site.sign, ...site.stones]) {
      const near = nearestPath(
        prop.x,
        prop.z,
        prop.footprint + PATH_HALF_WIDTH + 6
      );
      if (near && near.dist < PATH_HALF_WIDTH + prop.footprint) {
        console.warn(
          '[riddle] ' + site.id + ' prop at ' + prop.x + ',' + prop.z +
            ' overlaps the trail'
        );
      }
    }
  }

  scene.add(group);
  return group;
}
