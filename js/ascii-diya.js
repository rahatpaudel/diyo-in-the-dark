/**
 * AsciiDiya — a minimal, animated ASCII diya used as the loading screen.
 *
 * Plain classic script (no modules, no build step) so it works both from
 * http:// and file://. Nothing but the diya is drawn: no HUD, no progress
 * bar, no background particles, scanlines or decorative overlays.
 *
 * Every cell of the bowl and the flame is a randomised ASCII symbol or
 * letter, and those glyphs keep re-rolling while the lamp burns.
 *
 * Fire animation has two phases:
 *   intro — a spark at the wick grows into the flame with a little overshoot,
 *           while the clay body warms up under it;
 *   idle  — the flame settles into a continuous, gently wavering flicker.
 *
 * Public API
 *   var loader = AsciiDiya.create(canvas, options);
 *   loader.start();
 *   loader.ready();     // fades out after minDuration
 *   loader.restart();
 *   loader.destroy();
 *   AsciiDiya.autoInit(options);
 *
 * Options: minDuration, holdDuration, fadeDuration, maxDuration, onDone.
 * Never calling ready() keeps the animation running indefinitely.
 */
(function (global) {
  'use strict';

  var MONO =
    'ui-monospace, "SFMono-Regular", "Cascadia Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace';

  /* ------------------------------------------------------------------ */
  /*  Glyph pools, ordered from faint to heavy                          */
  /* ------------------------------------------------------------------ */
  var POOLS = [
    ".,:;'`~-_^",
    '+*=<>/\\|()[]{}!?',
    'abcdefghijklmnopqrstuvwxyz',
    'ABCDEFGHKLMNPRSTUVWXYZ',
    '#@%&$8B0OQ'
  ];

  /* ------------------------------------------------------------------ */
  /*  Colour ramps                                                      */
  /* ------------------------------------------------------------------ */
  var CLAY = [
    [0.0, [14, 7, 4]],
    [0.22, [44, 20, 9]],
    [0.45, [92, 43, 19]],
    [0.65, [148, 70, 30]],
    [0.82, [204, 106, 46]],
    [0.93, [238, 146, 70]],
    [1.0, [255, 193, 124]]
  ];

  var FIRE = [
    [0.0, [112, 22, 6]],
    [0.18, [216, 62, 11]],
    [0.38, [255, 116, 24]],
    [0.56, [255, 166, 51]],
    [0.74, [255, 208, 97]],
    [0.88, [255, 236, 158]],
    [1.0, [255, 252, 233]]
  ];

  /* ------------------------------------------------------------------ */
  /*  Small helpers                                                     */
  /* ------------------------------------------------------------------ */
  function clamp(v, a, b) {
    return v < a ? a : v > b ? b : v;
  }

  function hash2(ix, iy, seed) {
    var h =
      Math.imul(ix, 374761393) ^
      Math.imul(iy, 668265263) ^
      Math.imul(seed, 1442695041);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }

  function pickGlyph(ix, iy, seed, weight) {
    var pool =
      weight < 0.2
        ? POOLS[0]
        : weight < 0.42
        ? POOLS[1]
        : weight < 0.64
        ? POOLS[2]
        : weight < 0.84
        ? POOLS[3]
        : POOLS[4];
    return pool.charAt((hash2(ix, iy, seed) * pool.length) | 0);
  }

  function colorAt(stops, t) {
    t = clamp(t, 0, 1);
    for (var i = 1; i < stops.length; i++) {
      if (t <= stops[i][0]) {
        var a = stops[i - 1];
        var b = stops[i];
        var k = (t - a[0]) / (b[0] - a[0] || 1);
        return [
          a[1][0] + (b[1][0] - a[1][0]) * k,
          a[1][1] + (b[1][1] - a[1][1]) * k,
          a[1][2] + (b[1][2] - a[1][2]) * k
        ];
      }
    }
    return stops[stops.length - 1][1].slice();
  }

  // Quantised fillStyle cache: thousands of glyphs, very few colours.
  function makeRgbCache() {
    var cache = Object.create(null);
    return function (c) {
      var r = (c[0] | 0) & ~7;
      var g = (c[1] | 0) & ~7;
      var b = (c[2] | 0) & ~7;
      var key = (r << 16) | (g << 8) | b;
      var s = cache[key];
      if (!s) {
        s = 'rgb(' + r + ',' + g + ',' + b + ')';
        cache[key] = s;
      }
      return s;
    };
  }

  /* ------------------------------------------------------------------ */
  /*  Diya geometry (world units)                                       */
  /*                                                                     */
  /*  x: -1.30 .. 1.30                                                  */
  /*  y: -0.70 (base) .. 1.64 (headroom above the flame tip)            */
  /*                                                                     */
  /*  The bowl is deliberately low and wide; the flame is the tall part. */
  /* ------------------------------------------------------------------ */
  var A = 1.3; // bowl half-width at the rim
  var BOTTOM = -0.7; // bowl base
  var RIM_Y = 0.02; // centre of the rim ellipse
  var RIM_B = 0.15; // half-height of the rim ellipse (opening depth)
  var BASE_W = 0.34; // half-width of the rounded foot
  var TOP = 1.64; // headroom for the tallest flicker of the tip

  var WORLD_W = A * 2;
  var WORLD_H = TOP - BOTTOM;
  var BOWL_H = RIM_Y - BOTTOM;

  var F_BASE = 0.12; // flame root
  var F_H = 1.32; // flame height
  var F_W = 0.38; // flame half-width at its widest

  function halfWidthAt(y) {
    var v = clamp((y - BOTTOM) / BOWL_H, 0, 1);
    // Smooth bowl: a small rounded foot, steeply curving sides, then a
    // gentle flare into the rim.
    var s = Math.sin((v * Math.PI) / 2);
    var w = BASE_W + (A - BASE_W) * Math.pow(s, 1.1);
    if (v < 0.08) {
      var u = v / 0.08;
      w *= 0.62 + 0.38 * Math.sqrt(1 - (1 - u) * (1 - u));
    }
    return w;
  }

  function rimEllipse(x) {
    var k = 1 - (x * x) / (A * A);
    return Math.sqrt(k > 0 ? k : 0);
  }

  function rimBack(x) {
    return RIM_Y + RIM_B * rimEllipse(x);
  }

  function rimFront(x) {
    return RIM_Y - RIM_B * rimEllipse(x);
  }

  // Dramatic teardrop: a heavy belly low down, an inward-curved waist,
  // then a long pinch to a fine tip.
  function flameHalf(h) {
    if (h <= 0) return 0;
    var belly = Math.pow(Math.sin(Math.PI * Math.pow(h, 0.68)), 0.78);
    var ripple = 1 + 0.09 * Math.sin(h * Math.PI * 2.4 - 0.5) * (0.3 + 0.7 * h);
    return belly * ripple;
  }

  var DEFAULTS = {
    minDuration: 1700,
    holdDuration: 450,
    fadeDuration: 900,
    maxDuration: 6000,
    onDone: null
  };

  /* ------------------------------------------------------------------ */
  /*  Constructor                                                       */
  /* ------------------------------------------------------------------ */
  function AsciiDiya(canvas, options) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.container = canvas.parentElement;
    this.o = {};
    for (var k in DEFAULTS) this.o[k] = DEFAULTS[k];
    for (var j in options || {}) this.o[j] = options[j];

    this.readyCalled = false;
    this.readyAt = 0;
    this.startTime = 0;
    this.lastDraw = 0;
    this.elapsed = 0;
    this.cx = 0;
    this.cy = 0;
    this.running = false;
    this.done = false;
    this.raf = 0;
    this.fadeTimer = 0;
    this.removeTimer = 0;
    this.safetyTimer = 0;

    this.rows = 0;
    this.cols = 0;
    this.cellW = 0;
    this.cellH = 0;
    this.left = 0;
    this.top = 0;
    this.font = '';
    this.vw = 0;
    this.vh = 0;
    this.stepX = WORLD_W / 55;
    this.stepY = WORLD_H / 33;
    this.progress = 0;

    // Flicker + ignition state, refreshed each frame.
    this.hMod = 1;
    this.wMod = 1;
    this.sway = 0;
    this.sway2 = 0;
    this.snake = 0;
    this.pulse = 1;
    this.flameH = 0.08;
    this.flameW = 0.4;
    this.lit = 0;

    this._cell = { kind: 0, d: 0, h: 0, k: 0 };
    this._rgb = makeRgbCache();

    this._onResize = this.resize.bind(this);
    this._tick = this.tick.bind(this);

    global.addEventListener('resize', this._onResize);
    this.resize();
  }

  AsciiDiya.prototype = {
    constructor: AsciiDiya,

    /* ---------------------------------------------------------------- */
    /*  Layout                                                          */
    /* ---------------------------------------------------------------- */
    resize: function () {
      var canvas = this.canvas;
      var ctx = this.ctx;
      var dpr = Math.min(global.devicePixelRatio || 1, 2);
      var vw = canvas.clientWidth || global.innerWidth || 320;
      var vh = canvas.clientHeight || global.innerHeight || 480;

      this.vw = vw;
      this.vh = vh;

      canvas.width = Math.max(1, Math.round(vw * dpr));
      canvas.height = Math.max(1, Math.round(vh * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      // A small, centred emblem: about 36% of the viewport height.
      var unit = Math.min((vh * 0.36) / WORLD_H, (vw * 0.6) / WORLD_W);
      var rows = Math.round(clamp((WORLD_H * unit) / 14, 16, 34));
      var cellH = (WORLD_H * unit) / rows;
      var fontSize = cellH;

      ctx.font = fontSize + 'px ' + MONO;
      var cellW = ctx.measureText('M').width || fontSize * 0.6;
      var cols = Math.max(14, Math.round((WORLD_W * unit) / cellW));

      var gridW = cols * cellW;
      var gridH = rows * cellH;

      this.rows = rows;
      this.cols = cols;
      this.cellW = cellW;
      this.cellH = cellH;
      this.font = fontSize + 'px ' + MONO;
      this.left = (vw - gridW) / 2;
      // Sit a touch above dead centre to balance the caption underneath.
      this.top = (vh - gridH) / 2 - Math.min(26, vh * 0.03);
      if (this.container) {
        this.container.style.setProperty('--diya-grid-h', gridH.toFixed(1) + 'px');
        this.container.style.setProperty(
          '--diya-bottom',
          (this.top + gridH).toFixed(1) + 'px'
        );
      }
      this.cx = vw / 2;
      this.cy = vh / 2;
      this.stepX = WORLD_W / cols;
      this.stepY = WORLD_H / rows;

      if (this.running && this.lastDraw) this.render(this.lastDraw);
    },

    /* ---------------------------------------------------------------- */
    /*  Motion: ignition intro, then idle flicker                       */
    /* ---------------------------------------------------------------- */
    updateMotion: function (t) {
      // Ignition: a spark at the wick that grows into the flame.
      var grow = clamp((t - 0.25) / 1.05, 0, 1);
      var e = 1 - Math.pow(1 - grow, 3);
      var over = 1 + 0.12 * Math.sin(Math.PI * grow);

      this.flameH = 0.08 + 0.92 * e * over;
      this.flameW = 0.4 + 0.6 * e;
      this.lit = clamp(e * 1.15, 0, 1);

      // Idle flicker (and a little turbulence left over from the ignition).
      var kick = Math.exp(-t * 1.7) * 0.07;
      this.hMod =
        1 +
        0.07 * Math.sin(t * 6.7) +
        0.045 * Math.sin(t * 11.3 + 1.7) +
        0.02 * Math.sin(t * 23.1 + 0.4) +
        kick * Math.sin(t * 27);
      this.wMod =
        1 + 0.09 * Math.sin(t * 8.3 + 0.6) + 0.05 * Math.sin(t * 15.7 + 2.1);
      this.sway = 0.11 * Math.sin(t * 1.5) + 0.055 * Math.sin(t * 3.6 + 1.1);
      this.sway2 = 0.03 * Math.sin(t * 6.4 + 2.7);
      this.snake = 0.05 * Math.sin(t * 4.4 + 0.3);
      this.pulse = 1 + 0.06 * Math.sin(t * 5.1) + 0.03 * Math.sin(t * 9.7);
    },

    /* ---------------------------------------------------------------- */
    /*  Shape sampling                                                  */
    /* ---------------------------------------------------------------- */
    sample: function (x, y, t) {
      var out = this._cell;
      out.kind = 0;
      out.d = 0;
      out.h = 0;
      out.k = 0;

      /* --- flame ---------------------------------------------------- */
      var fh = F_H * this.hMod * this.flameH;
      if (y > F_BASE && y < F_BASE + fh) {
        var h = (y - F_BASE) / fh;
        var w = flameHalf(h) * F_W * this.wMod * this.flameW;
        // Two ripples crawl up the flame so its edges stay in motion.
        w *= 1 + 0.1 * Math.sin(h * 6.2 - t * 3.6) * (0.25 + 0.75 * h);
        var dx =
          x -
          this.sway * Math.pow(h, 1.9) -
          this.sway2 * Math.pow(h, 3.4) -
          this.snake * Math.sin(h * 4.6 - t * 2.6) * h -
          0.013 * Math.sin(t * 13.1) * Math.pow(h, 4.5);
        var k = Math.abs(dx) / (w || 1e-6);
        if (k <= 1) {
          var heat = (1 - 0.62 * k) * (1 - 0.18 * h);
          if (k < 0.46 && h < 0.82) {
            heat = Math.max(heat, 0.84 - 0.3 * h);
          }
          heat *= 0.62 + 0.38 * this.lit;
          heat += 0.05 * Math.sin(t * 12 + y * 8 + x * 3);
          out.kind = 5;
          out.h = h;
          out.k = k;
          out.d = clamp(heat, 0.05, 1);
          return out;
        }
      }

      /* --- wick ----------------------------------------------------- */
      if (Math.abs(x) < 0.055 && y <= F_BASE + 0.02 && y > -0.06) {
        out.kind = 4;
        out.d = clamp((y + 0.06) / (F_BASE + 0.08), 0, 1);
        return out;
      }

      /* --- clay bowl ------------------------------------------------ */
      if (y > rimBack(x) || y < BOTTOM) return out;

      var hw = halfWidthAt(y);
      if (Math.abs(x) > hw) return out;

      var front = rimFront(x);
      var ax = Math.abs(x) / A;
      // Keep the rim at least one glyph row thick, whatever the resolution.
      var band = Math.max(0.045, this.stepY * 0.85);
      var lit = 0.4 + 0.6 * this.lit;

      // Inside of the bowl: a dark well with a warm pool under the flame.
      if (ax < 1 - 0.09 && y > front + 0.008 && y < rimBack(x) - band * 0.7) {
        var g = Math.exp(-(x * x * 1.7 + (y - 0.04) * (y - 0.04) * 2.4) * 0.9);
        out.kind = 1;
        out.d = clamp((0.04 + 0.32 * g) * lit, 0, 1);
        return out;
      }

      // Rim: bright front lip, slightly cooler back edge.
      if (y >= front - band) {
        var backT = clamp(
          (y - front - band * 0.25) / (rimBack(x) - front + band),
          0,
          1
        );
        out.kind = 3;
        out.d = clamp((0.96 - 0.34 * backT - 0.1 * ax * ax) * lit, 0, 1);
        return out;
      }

      // Bowl wall, lit from above by its own flame.
      var v = clamp((y - BOTTOM) / BOWL_H, 0, 1);
      var d = 0.18 + 0.44 * v;
      d += 0.32 * Math.exp(-(x * x * 1.05 + (y - 0.04) * (y - 0.04) * 2.4));
      d -= 0.12 * Math.pow(ax, 2.5) * (1 - v);
      if (Math.abs(x) > hw - 0.05) d = Math.max(d, 0.5 + 0.16 * v);

      out.kind = 2;
      out.d = clamp(d * lit, 0, 1);
      return out;
    },

    /* ---------------------------------------------------------------- */
    /*  Render                                                          */
    /* ---------------------------------------------------------------- */
    render: function (now) {
      var ctx = this.ctx;
      var rows = this.rows;
      var cols = this.cols;
      if (!rows || !cols) return;

      var t = this.elapsed;
      this.updateMotion(t);
      ctx.clearRect(0, 0, this.vw, this.vh);

      ctx.font = this.font;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      var stepX = WORLD_W / cols;
      var stepY = WORLD_H / rows;
      var flameSeed = (t * 8) | 0;
      var pulse = this.pulse;
      var rgb = this._rgb;

      for (var r = 0; r < rows; r++) {
        var y = TOP - (r + 0.5) * stepY;
        var py = this.top + (r + 0.5) * this.cellH;

        for (var c = 0; c < cols; c++) {
          var x = -A + (c + 0.5) * stepX;
          var cell = this.sample(x, y, t);
          var kind = cell.kind;
          if (kind === 0) continue;

          var ch;
          var col;

          if (kind === 5) {
            ch = pickGlyph(c, r, flameSeed + ((hash2(c, r, 9) * 3) | 0), cell.d);
            col = colorAt(FIRE, cell.d);
          } else if (kind === 4) {
            ch = cell.d > 0.55 ? 'i' : '|';
            col = cell.d > 0.55 ? [255, 152, 52] : [92, 38, 16];
          } else {
            // Every clay glyph re-rolls a few times a second, staggered
            // cell by cell so the body shimmers instead of blinking.
            var seed = (t * 3.5 + hash2(c, r, 5)) | 0;
            if (kind === 1) {
              if (hash2(c, r, 3) < 0.34) continue; // sparse dark interior
              ch = pickGlyph(c, r, seed, cell.d * 1.5);
              col = colorAt(CLAY, cell.d * 0.7);
            } else if (kind === 3) {
              ch = pickGlyph(c, r, seed, cell.d);
              col = colorAt(CLAY, clamp(cell.d * pulse, 0, 1));
            } else {
              ch = pickGlyph(c, r, seed, cell.d);
              col = colorAt(CLAY, clamp(cell.d * pulse, 0, 1));
            }
          }

          ctx.fillStyle = rgb(col);
          ctx.fillText(ch, this.left + (c + 0.5) * this.cellW, py);
        }
      }
    },

    /* ---------------------------------------------------------------- */
    /*  Loop                                                            */
    /* ---------------------------------------------------------------- */
    start: function () {
      if (this.running || this.done) return;
      this.running = true;
      this.startTime = performance.now() - this.elapsed * 1000;
      this.lastDraw = 0;
      this.raf = global.requestAnimationFrame(this._tick);

      if (this.o.maxDuration > 0) {
        var self = this;
        this.safetyTimer = global.setTimeout(function () {
          if (!self.readyCalled) self.ready();
        }, this.o.maxDuration);
      }
    },

    tick: function (now) {
      if (!this.running) return;
      this.raf = global.requestAnimationFrame(this._tick);
      if (now - this.lastDraw < 31) return; // ~32 fps is plenty
      this.lastDraw = now;
      this.elapsed = (now - this.startTime) / 1000;
      this.render(now);
    },

    /* ---------------------------------------------------------------- */
    /*  Lifecycle                                                       */
    /* ---------------------------------------------------------------- */
    // Kept for API compatibility; the visual has no progress bar.
    setProgress: function (p) {
      this.progress = clamp(Number(p) || 0, 0, 1);
    },

    ready: function () {
      if (this.readyCalled || this.done) return;
      this.readyCalled = true;
      this.readyAt = this.elapsed;

      var wait =
        Math.max(0, this.o.minDuration - this.elapsed * 1000) +
        this.o.holdDuration;
      var self = this;
      this.fadeTimer = global.setTimeout(function () {
        self.fadeOut();
      }, wait);
    },

    fadeOut: function () {
      if (this.done) return;
      this.done = true;
      this.container.classList.add('is-hidden');
      if (document.body) document.body.classList.remove('is-loading');

      var self = this;
      this.removeTimer = global.setTimeout(function () {
        self.running = false;
        global.cancelAnimationFrame(self.raf);
        self.container.classList.add('is-removed');
        if (typeof self.o.onDone === 'function') self.o.onDone();
      }, this.o.fadeDuration);
    },

    restart: function () {
      global.clearTimeout(this.fadeTimer);
      global.clearTimeout(this.removeTimer);
      global.clearTimeout(this.safetyTimer);

      this.done = false;
      this.readyCalled = false;
      this.readyAt = 0;
      this.elapsed = 0;
      this.progress = 0;
      this.container.classList.remove('is-hidden');
      this.container.classList.remove('is-removed');
      if (document.body) document.body.classList.add('is-loading');
      this.running = false;
      this.start();
    },

    destroy: function () {
      global.cancelAnimationFrame(this.raf);
      global.clearTimeout(this.fadeTimer);
      global.clearTimeout(this.removeTimer);
      global.clearTimeout(this.safetyTimer);
      global.removeEventListener('resize', this._onResize);
      this.running = false;
      this.done = true;
      if (AsciiDiya.loader === this) AsciiDiya.loader = null;
    },

    /* Diagnostics: a structural view of the current shape. */
    structure: function () {
      var out = [];
      var rows = this.rows || 33;
      var cols = this.cols || 55;
      var stepX = WORLD_W / cols;
      var stepY = WORLD_H / rows;
      for (var r = 0; r < rows; r++) {
        var line = '';
        for (var c = 0; c < cols; c++) {
          var cell = this.sample(
            -A + (c + 0.5) * stepX,
            TOP - (r + 0.5) * stepY,
            0
          );
          line +=
            cell.kind === 0
              ? ' '
              : cell.kind === 5
              ? cell.d > 0.75
                ? '@'
                : '*'
              : cell.kind === 4
              ? '|'
              : cell.kind === 3
              ? '-'
              : cell.kind === 2
              ? '='
              : '.';
        }
        out.push(line.replace(/\s+$/, ''));
      }
      return out.join('\n');
    }
  };

  /* ------------------------------------------------------------------ */
  /*  Factory / auto-init                                               */
  /* ------------------------------------------------------------------ */
  AsciiDiya.create = function (canvas, options) {
    return new AsciiDiya(canvas, options);
  };

  AsciiDiya.autoInit = function (options) {
    var container = document.getElementById('ascii-loader');
    if (!container) return null;
    var canvas = container.querySelector('canvas');
    if (!canvas) return null;

    var loader = new AsciiDiya(canvas, options);
    if (document.body) document.body.classList.add('is-loading');
    AsciiDiya.loader = loader;
    loader.start();
    return loader;
  };

  AsciiDiya.loader = null;
  global.AsciiDiya = AsciiDiya;
})(window);
