'use strict';
/* ==========================================================================
   VIPERA — Game Engine & UI Controller
   Organized in clear modules: Utils → Storage → Audio → Particles →
   HeroSnake (home screen decoration) → SnakeGame (core engine) → App (UI glue)
   ========================================================================== */

/* ---------------------------- Utilities ---------------------------------- */

const $  = (sel, ctx = document) => ctx.querySelector(sel);
const $$ = (sel, ctx = document) => Array.from(ctx.querySelectorAll(sel));
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const lerp  = (a, b, t) => a + (b - a) * t;
const rand  = (min, max) => Math.random() * (max - min) + min;
const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ---------------------------- Storage layer ------------------------------- */
/* Wraps localStorage with safe JSON parsing so a private-browsing or quota
   failure never crashes the game — it just falls back gracefully. */

const Storage = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
  }
};

const STORAGE_KEYS = {
  highScore: 'vipera:highScore',
  gamesPlayed: 'vipera:gamesPlayed',
  bestLength: 'vipera:bestLength',
  settings: 'vipera:settings'
};

const defaultSettings = {
  sfx: true,
  music: false,
  grid: true,
  wrap: false,
  difficulty: 'medium'
};

const settings = Object.assign({}, defaultSettings, Storage.get(STORAGE_KEYS.settings, {}));

function saveSettings() { Storage.set(STORAGE_KEYS.settings, settings); }

/* ---------------------------- Audio engine -------------------------------- */
/* All sound is generated procedurally with the Web Audio API — zero audio
   files to download, so the page stays light and fast. The AudioContext is
   created lazily on first user gesture to respect browser autoplay policy. */

class AudioEngine {
  constructor() {
    this.ctx = null;
    this.musicNodes = null;
  }

  ensureContext() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) this.ctx = new AC();
    }
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }

  tone({ freq = 440, duration = 0.12, type = 'sine', gain = 0.18, glideTo = null, delay = 0 }) {
    if (!settings.sfx) return;
    const ctx = this.ensureContext();
    if (!ctx) return;
    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const amp = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (glideTo) osc.frequency.exponentialRampToValueAtTime(glideTo, t0 + duration);
    amp.gain.setValueAtTime(0.0001, t0);
    amp.gain.exponentialRampToValueAtTime(gain, t0 + 0.015);
    amp.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    osc.connect(amp).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + duration + 0.02);
  }

  eat(combo = 0) {
    const freq = 520 + clamp(combo, 0, 10) * 22;
    this.tone({ freq, glideTo: freq * 1.6, duration: 0.14, type: 'triangle', gain: 0.2 });
  }

  turn() {
    this.tone({ freq: 340, duration: 0.045, type: 'sine', gain: 0.05 });
  }

  click() {
    this.tone({ freq: 600, duration: 0.06, type: 'sine', gain: 0.09 });
  }

  gameOver() {
    this.tone({ freq: 420, glideTo: 120, duration: 0.5, type: 'sawtooth', gain: 0.14 });
    this.tone({ freq: 300, glideTo: 90, duration: 0.6, type: 'sine', gain: 0.12, delay: 0.05 });
  }

  countdownBeep(final = false) {
    this.tone({ freq: final ? 720 : 480, duration: final ? 0.22 : 0.1, type: 'sine', gain: 0.16 });
  }

  startMusic() {
    if (!settings.music) return;
    const ctx = this.ensureContext();
    if (!ctx || this.musicNodes) return;

    const master = ctx.createGain();
    master.gain.value = 0.05;
    master.connect(ctx.destination);

    // Two slow, detuned pads drifting via LFO — a soft ambient bed.
    const notes = [196.0, 246.94, 329.63]; // G3, B3, E4 — airy major triad
    const oscs = notes.map((f, i) => {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = f;
      const g = ctx.createGain();
      g.gain.value = 0.5;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.06 + i * 0.015;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = 0.15;
      lfo.connect(lfoGain).connect(g.gain);
      osc.connect(g).connect(master);
      osc.start();
      lfo.start();
      return { osc, lfo, g };
    });

    this.musicNodes = { master, oscs };
  }

  stopMusic() {
    if (!this.musicNodes) return;
    const { master, oscs } = this.musicNodes;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    master.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
    setTimeout(() => {
      oscs.forEach(({ osc, lfo }) => { try { osc.stop(); lfo.stop(); } catch {} });
    }, 500);
    this.musicNodes = null;
  }

  toggleMusic() {
    if (settings.music) this.startMusic(); else this.stopMusic();
  }
}

const audio = new AudioEngine();

/* ---------------------------- Ambient particles --------------------------- */
/* A quiet full-page field of drifting bubbles for premium atmosphere.
   Skips animation entirely when the user prefers reduced motion. */

class AmbientParticles {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.particles = [];
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.resize();
    window.addEventListener('resize', () => this.resize());
    if (!prefersReducedMotion) {
      this.populate();
      requestAnimationFrame((t) => this.loop(t));
    }
  }

  resize() {
    const { innerWidth: w, innerHeight: h } = window;
    this.canvas.width = w * this.dpr;
    this.canvas.height = h * this.dpr;
    this.w = w; this.h = h;
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  populate() {
    const count = Math.round((this.w * this.h) / 42000);
    const palette = ['#10B981', '#06B6D4', '#2563EB', '#F5B942'];
    for (let i = 0; i < count; i++) {
      this.particles.push({
        x: rand(0, this.w),
        y: rand(0, this.h),
        r: rand(2, 5.5),
        speed: rand(6, 16),
        drift: rand(-8, 8),
        color: palette[Math.floor(rand(0, palette.length))],
        alpha: rand(0.05, 0.16)
      });
    }
  }

  loop(t) {
    const dt = Math.min((t - (this._last || t)) / 1000, 0.05);
    this._last = t;
    this.ctx.clearRect(0, 0, this.w, this.h);
    for (const p of this.particles) {
      p.y -= p.speed * dt;
      p.x += p.drift * dt * 0.3;
      if (p.y < -10) { p.y = this.h + 10; p.x = rand(0, this.w); }
      if (p.x < -10) p.x = this.w + 10;
      if (p.x > this.w + 10) p.x = -10;
      this.ctx.beginPath();
      this.ctx.fillStyle = p.color;
      this.ctx.globalAlpha = p.alpha;
      this.ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      this.ctx.fill();
    }
    this.ctx.globalAlpha = 1;
    requestAnimationFrame((t2) => this.loop(t2));
  }
}

/* ---------------------------- Hero snake (home screen signature) ---------- */
/* A small living snake slithers endlessly along the decorative SVG path
   behind the Play button — the page's one signature flourish. */

class HeroSnake {
  constructor(canvas, pathEl) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.pathEl = pathEl;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.segCount = 9;
    this.progress = 0;
    this.resize();
    window.addEventListener('resize', () => this.resize());
    if (!prefersReducedMotion) requestAnimationFrame((t) => this.loop(t));
    else this.renderStatic();
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = rect.width * this.dpr;
    this.canvas.height = rect.height * this.dpr;
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.cssW = rect.width; this.cssH = rect.height;
    this.pathLength = this.pathEl.getTotalLength();
    // The path viewBox is 600x160 — scale points into the canvas's own box.
    this.scaleX = this.cssW / 600;
    this.scaleY = this.cssH / 160;
  }

  pointAt(dist) {
    const d = ((dist % this.pathLength) + this.pathLength) % this.pathLength;
    const p = this.pathEl.getPointAtLength(d);
    return { x: p.x * this.scaleX, y: p.y * this.scaleY };
  }

  renderStatic() { this.draw(0.35); }

  loop(t) {
    const speed = 46; // px of path travelled per second
    this.progress = (t / 1000) * speed;
    this.draw();
    requestAnimationFrame((t2) => this.loop(t2));
  }

  draw() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.cssW, this.cssH);
    const spacing = 12;
    const grad = ctx.createLinearGradient(0, 0, this.cssW, 0);
    grad.addColorStop(0, '#10B981');
    grad.addColorStop(0.55, '#06B6D4');
    grad.addColorStop(1, '#2563EB');

    for (let i = this.segCount - 1; i >= 0; i--) {
      const dist = this.progress - i * spacing;
      const { x, y } = this.pointAt(dist);
      const t = i / this.segCount;
      const r = lerp(9, 5, t);
      ctx.beginPath();
      ctx.fillStyle = i === 0 ? '#F5B942' : grad;
      ctx.globalAlpha = lerp(1, 0.35, t);
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
}

/* ---------------------------- Snake game engine ---------------------------- */

const DIFFICULTY = {
  easy:   { label: 'Easy',   tickMs: 165, scorePerFood: 5,  rampEvery: 6, rampFactor: 0.985, minTick: 100 },
  medium: { label: 'Medium', tickMs: 118, scorePerFood: 10, rampEvery: 5, rampFactor: 0.98,  minTick: 72  },
  hard:   { label: 'Hard',   tickMs: 82,  scorePerFood: 15, rampEvery: 4, rampFactor: 0.975, minTick: 52  }
};

const GRID_SIZE = 22;

class SnakeGame {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.particles = []; // eat / game-over burst particles, local to the board
    this.state = 'idle'; // idle | countdown | running | paused | gameover
    this.onScoreChange = null;
    this.onGameOver = null;
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas.parentElement);
    this.resize();
    this._raf = null;
  }

  resize() {
    const rect = this.canvas.parentElement.getBoundingClientRect();
    const size = Math.max(rect.width, 120);
    this.canvas.width = size * this.dpr;
    this.canvas.height = size * this.dpr;
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.cssSize = size;
    this.cell = size / GRID_SIZE;
    if (this.state === 'idle') this.drawIdleGrid();
    else this.render(1);
  }

  /* ---- Setup / lifecycle ---- */

  configure(difficultyKey) {
    this.difficultyKey = difficultyKey;
    this.difficulty = DIFFICULTY[difficultyKey];
    this.tickMs = this.difficulty.tickMs;
  }

  reset() {
    const mid = Math.floor(GRID_SIZE / 2);
    this.snake = [
      { x: mid - 1, y: mid },
      { x: mid - 2, y: mid },
      { x: mid - 3, y: mid }
    ];
    this.prevSnake = this.snake.map(s => ({ ...s }));
    this.direction = { x: 1, y: 0 };
    this.pendingDirection = null;
    this.queuedDirection = null;
    this.pendingGrowth = 0;
    this.score = 0;
    this.foodEatenCount = 0;
    this.accumulator = 0;
    this.particles = [];
    this.spawnFood();
  }

  spawnFood() {
    const occupied = new Set(this.snake.map(s => `${s.x},${s.y}`));
    let x, y;
    do {
      x = Math.floor(rand(0, GRID_SIZE));
      y = Math.floor(rand(0, GRID_SIZE));
    } while (occupied.has(`${x},${y}`));
    this.food = { x, y, spawnedAt: performance.now() };
  }

  start() {
    this.reset();
    this.state = 'countdown';
  }

  beginRunning() {
    this.state = 'running';
    this._last = performance.now();
    this._loopBound = this._loopBound || ((t) => this.loop(t));
    this._raf = requestAnimationFrame(this._loopBound);
  }

  pause() {
    if (this.state !== 'running') return;
    this.state = 'paused';
    cancelAnimationFrame(this._raf);
  }

  resume() {
    if (this.state !== 'paused') return;
    this.state = 'running';
    this._last = performance.now();
    this._raf = requestAnimationFrame(this._loopBound);
  }

  stop() {
    this.state = 'idle';
    cancelAnimationFrame(this._raf);
  }

  /* ---- Input ---- */

  setDirection(dx, dy) {
    if (this.state !== 'running' && this.state !== 'countdown') return;
    const last = this.queuedDirection || this.direction;
    // Ignore direct reversals and no-ops.
    if (dx === -last.x && dy === -last.y) return;
    if (dx === last.x && dy === last.y) return;
    this.queuedDirection = { x: dx, y: dy };
    audio.turn();
  }

  /* ---- Core loop ---- */

  loop(t) {
    if (this.state !== 'running') return;
    const dt = t - this._last;
    this._last = t;
    this.accumulator += dt;

    while (this.accumulator >= this.tickMs) {
      this.tick();
      this.accumulator -= this.tickMs;
    }

    this.updateParticles(dt / 1000);
    const alpha = clamp(this.accumulator / this.tickMs, 0, 1);
    this.render(alpha);
    this._raf = requestAnimationFrame(this._loopBound);
  }

  tick() {
    this.prevSnake = this.snake.map(s => ({ ...s }));

    if (this.queuedDirection) {
      this.direction = this.queuedDirection;
      this.queuedDirection = null;
    }

    const head = this.snake[0];
    let nx = head.x + this.direction.x;
    let ny = head.y + this.direction.y;

    if (settings.wrap) {
      nx = (nx + GRID_SIZE) % GRID_SIZE;
      ny = (ny + GRID_SIZE) % GRID_SIZE;
    } else if (nx < 0 || nx >= GRID_SIZE || ny < 0 || ny >= GRID_SIZE) {
      return this.endGame();
    }

    // Self collision — the tail cell is safe if the snake isn't growing
    // this tick, since it will have moved out of the way.
    const willGrow = this.pendingGrowth > 0;
    const bodyToCheck = willGrow ? this.snake : this.snake.slice(0, -1);
    if (bodyToCheck.some(s => s.x === nx && s.y === ny)) {
      return this.endGame();
    }

    this.snake.unshift({ x: nx, y: ny });

    if (nx === this.food.x && ny === this.food.y) {
      this.foodEatenCount++;
      this.pendingGrowth += 1;
      this.score += this.difficulty.scorePerFood;
      audio.eat(this.foodEatenCount % 12);
      this.spawnBurst(this.food.x, this.food.y);
      this.spawnFood();
      if (this.onScoreChange) this.onScoreChange(this.score, true);
      // Gentle speed ramp keeps later play lively without becoming unfair.
      if (this.foodEatenCount % this.difficulty.rampEvery === 0) {
        this.tickMs = Math.max(this.difficulty.minTick, this.tickMs * this.difficulty.rampFactor);
      }
    } else if (this.onScoreChange) {
      this.onScoreChange(this.score, false);
    }

    if (this.pendingGrowth > 0) {
      this.pendingGrowth--;
    } else {
      this.snake.pop();
    }
  }

  endGame() {
    this.state = 'gameover';
    cancelAnimationFrame(this._raf);
    this.spawnBurst(this.snake[0].x, this.snake[0].y, true);
    audio.gameOver();
    if (this.onGameOver) this.onGameOver(this.score, this.snake.length);
  }

  /* ---- Particles (local burst effects) ---- */

  spawnBurst(gx, gy, big = false) {
    const cx = (gx + 0.5) * this.cell;
    const cy = (gy + 0.5) * this.cell;
    const count = big ? 26 : 12;
    const palette = big ? ['#EF4444', '#F5B942', '#2563EB'] : ['#F5B942', '#10B981', '#06B6D4'];
    for (let i = 0; i < count; i++) {
      const angle = rand(0, Math.PI * 2);
      const speed = rand(40, big ? 220 : 130);
      this.particles.push({
        x: cx, y: cy,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        r: rand(2, big ? 5 : 3.5),
        life: 1,
        decay: rand(1.1, 1.8),
        color: palette[Math.floor(rand(0, palette.length))]
      });
    }
  }

  updateParticles(dt) {
    for (const p of this.particles) {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += 90 * dt; // gentle gravity
      p.life -= p.decay * dt;
    }
    this.particles = this.particles.filter(p => p.life > 0);
  }

  /* ---- Rendering ---- */

  drawIdleGrid() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.cssSize, this.cssSize);
  }

  render(alpha) {
    const ctx = this.ctx;
    const size = this.cssSize;
    ctx.clearRect(0, 0, size, size);

    if (settings.grid) this.drawGrid(ctx, size);
    this.drawFood(ctx);
    this.drawSnake(ctx, alpha);
    this.drawParticles(ctx);
  }

  drawGrid(ctx, size) {
    ctx.save();
    ctx.strokeStyle = 'rgba(15, 23, 42, 0.045)';
    ctx.lineWidth = 1;
    for (let i = 1; i < GRID_SIZE; i++) {
      const p = i * this.cell;
      ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, size); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(size, p); ctx.stroke();
    }
    ctx.restore();
  }

  drawFood(ctx) {
    if (!this.food) return;
    const cx = (this.food.x + 0.5) * this.cell;
    const cy = (this.food.y + 0.5) * this.cell;
    const age = (performance.now() - this.food.spawnedAt) / 1000;
    const pop = clamp(age / 0.25, 0, 1); // grow-in animation
    const pulse = 1 + Math.sin(performance.now() / 220) * 0.08;
    const r = (this.cell * 0.34) * pop * pulse;

    ctx.save();
    ctx.shadowColor = 'rgba(245, 185, 66, 0.65)';
    ctx.shadowBlur = this.cell * 0.6;
    const grad = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.3, r * 0.1, cx, cy, r);
    grad.addColorStop(0, '#FFF3D0');
    grad.addColorStop(0.5, '#F5B942');
    grad.addColorStop(1, '#E0A527');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  drawSnake(ctx, alpha) {
    if (!this.snake) return;
    const n = this.snake.length;
    const prev = this.prevSnake;
    const points = this.snake.map((s, i) => {
      const p = prev[i] || s;
      // Guard against wrap-teleport lerp glitches: if the jump is larger
      // than one cell, skip interpolation for that segment this frame.
      const dx = Math.abs(s.x - p.x), dy = Math.abs(s.y - p.y);
      const t = (dx > 1 || dy > 1) ? 1 : alpha;
      return {
        x: lerp(p.x, s.x, t) * this.cell + this.cell / 2,
        y: lerp(p.y, s.y, t) * this.cell + this.cell / 2
      };
    });

    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    // Body as a smooth stroked path with a brand gradient + soft glow.
    const grad = ctx.createLinearGradient(0, 0, this.cssSize, this.cssSize);
    grad.addColorStop(0, '#10B981');
    grad.addColorStop(0.6, '#06B6D4');
    grad.addColorStop(1, '#2563EB');

    ctx.shadowColor = 'rgba(16, 185, 129, 0.35)';
    ctx.shadowBlur = this.cell * 0.35;
    ctx.strokeStyle = grad;
    ctx.lineWidth = this.cell * 0.72;
    ctx.beginPath();
    points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Head: distinct rounded square with eyes + occasional tongue flick.
    const head = points[0];
    const dir = this.direction;
    const headSize = this.cell * 0.86;
    ctx.fillStyle = '#059669';
    ctx.beginPath();
    ctx.arc(head.x, head.y, headSize / 2, 0, Math.PI * 2);
    ctx.fill();

    const eyeOffset = headSize * 0.22;
    const perp = { x: -dir.y, y: dir.x };
    const forward = { x: dir.x * eyeOffset, y: dir.y * eyeOffset };
    [1, -1].forEach(side => {
      const ex = head.x + forward.x + perp.x * eyeOffset * side;
      const ey = head.y + forward.y + perp.y * eyeOffset * side;
      ctx.fillStyle = '#FFFFFF';
      ctx.beginPath(); ctx.arc(ex, ey, headSize * 0.14, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#0B1220';
      ctx.beginPath();
      ctx.arc(ex + dir.x * headSize * 0.04, ey + dir.y * headSize * 0.04, headSize * 0.07, 0, Math.PI * 2);
      ctx.fill();
    });

    ctx.restore();
  }

  drawParticles(ctx) {
    for (const p of this.particles) {
      ctx.save();
      ctx.globalAlpha = clamp(p.life, 0, 1);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }
}

/* ==========================================================================
   App controller — wires DOM, screens, modals and the game engine together
   ========================================================================== */

const App = (() => {
  let game;
  let heroSnake;
  let countdownTimer = null;
  let wasFullscreen = false;

  const els = {}; // populated on init

  function cacheEls() {
    Object.assign(els, {
      screenHome: $('#screen-home'),
      screenGame: $('#screen-game'),
      canvas: $('#game-canvas'),
      board: $('#board'),
      btnPlay: $('#btn-play'),
      btnHowto: $('#btn-howto'),
      btnHome: $('#btn-home'),
      btnPause: $('#btn-pause'),
      btnResume: $('#btn-resume'),
      btnRestartPaused: $('#btn-restart-paused'),
      btnHomePaused: $('#btn-home-paused'),
      btnPlayAgain: $('#btn-play-again'),
      btnHomeGameover: $('#btn-home-gameover'),
      btnSettings: $('#btn-settings'),
      btnCloseSettings: $('#btn-close-settings'),
      btnCloseHowto: $('#btn-close-howto'),
      btnSound: $('#btn-sound'),
      btnFullscreen: $('#btn-fullscreen'),
      btnResetData: $('#btn-reset-data'),
      settingsModal: $('#settings-modal'),
      howtoModal: $('#howto-modal'),
      overlayCountdown: $('#overlay-countdown'),
      countdownNumber: $('#countdown-number'),
      overlayPause: $('#overlay-pause'),
      overlayGameover: $('#overlay-gameover'),
      gameoverScore: $('#gameover-score'),
      gameoverBest: $('#gameover-best'),
      gameoverNewbest: $('#gameover-newbest'),
      hudScore: $('#hud-score'),
      hudHighscore: $('#hud-highscore'),
      hudDifficulty: $('#hud-difficulty'),
      homeHighscore: $('#home-highscore'),
      homeGamesPlayed: $('#home-games-played'),
      homeBestStreak: $('#home-best-streak'),
      difficultyPicker: $('#difficulty-picker'),
      touchControls: $('#touch-controls'),
      sr: $('#sr-announcer'),
      toggleSfx: $('#toggle-sfx'),
      toggleMusic: $('#toggle-music'),
      toggleGrid: $('#toggle-grid'),
      toggleWrap: $('#toggle-wrap')
    });
  }

  function announce(msg) { els.sr.textContent = msg; }

  /* ---- Stats ---- */

  function getStats() {
    return {
      highScore: Storage.get(STORAGE_KEYS.highScore, 0),
      gamesPlayed: Storage.get(STORAGE_KEYS.gamesPlayed, 0),
      bestLength: Storage.get(STORAGE_KEYS.bestLength, 3)
    };
  }

  function refreshHomeStats() {
    const s = getStats();
    els.homeHighscore.textContent = s.highScore;
    els.homeGamesPlayed.textContent = s.gamesPlayed;
    els.homeBestStreak.textContent = s.bestLength;
    els.hudHighscore.textContent = s.highScore;
  }

  /* ---- Screen switching ---- */

  function showScreen(name) {
    const showingGame = name === 'game';
    els.screenHome.hidden = showingGame;
    els.screenGame.hidden = !showingGame;
    if (showingGame) els.screenGame.focus?.();
  }

  /* ---- Modals ---- */

  let lastFocused = null;

  function openModal(modal) {
    lastFocused = document.activeElement;
    modal.hidden = false;
    const focusable = modal.querySelector('button, input, [tabindex]');
    focusable?.focus();
    document.addEventListener('keydown', onModalKeydown);
  }

  function closeModal(modal) {
    modal.hidden = true;
    document.removeEventListener('keydown', onModalKeydown);
    lastFocused?.focus();
  }

  function onModalKeydown(e) {
    if (e.key === 'Escape') {
      $$('.modal-backdrop').forEach(m => { if (!m.hidden) closeModal(m); });
    }
  }

  /* ---- Difficulty badge ---- */

  function updateDifficultyBadge(key) {
    const d = DIFFICULTY[key];
    els.hudDifficulty.textContent = d.label;
    els.hudDifficulty.className = `badge badge--${key}`;
  }

  /* ---- Game flow ---- */

  function startNewGame() {
    audio.ensureContext();
    const difficultyKey = $('input[name="difficulty"]:checked').value;
    settings.difficulty = difficultyKey;
    saveSettings();

    showScreen('game');
    updateDifficultyBadge(difficultyKey);
    els.overlayGameover.hidden = true;
    els.overlayPause.hidden = true;

    game.configure(difficultyKey);
    game.start();
    game.resize();
    els.hudScore.textContent = '0';
    els.hudHighscore.textContent = getStats().highScore;

    runCountdown(() => {
      game.beginRunning();
      audio.startMusic();
    });
  }

  function runCountdown(onDone) {
    let n = 3;
    els.overlayCountdown.hidden = false;
    els.countdownNumber.textContent = n;
    audio.countdownBeep(false);
    clearInterval(countdownTimer);
    countdownTimer = setInterval(() => {
      n--;
      if (n === 0) {
        els.countdownNumber.textContent = 'Go!';
        audio.countdownBeep(true);
        clearInterval(countdownTimer);
        setTimeout(() => {
          els.overlayCountdown.hidden = true;
          onDone();
        }, 380);
      } else {
        els.countdownNumber.textContent = n;
        audio.countdownBeep(false);
      }
    }, 620);
  }

  function handleScoreChange(score, scored) {
    els.hudScore.textContent = score;
    if (scored) {
      els.hudScore.classList.remove('score-pop');
      // Force reflow so the animation can restart on consecutive eats.
      void els.hudScore.offsetWidth;
      els.hudScore.classList.add('score-pop');
      if (score % 30 === 0) announce(`Score ${score}`);
    }
  }

  function handleGameOver(score, length) {
    const stats = getStats();
    const isNewBest = score > stats.highScore;
    if (isNewBest) Storage.set(STORAGE_KEYS.highScore, score);
    if (length > stats.bestLength) Storage.set(STORAGE_KEYS.bestLength, length);
    Storage.set(STORAGE_KEYS.gamesPlayed, stats.gamesPlayed + 1);
    refreshHomeStats();

    els.gameoverScore.textContent = score;
    els.gameoverBest.textContent = Math.max(score, stats.highScore);
    els.gameoverNewbest.hidden = !isNewBest;
    els.overlayGameover.hidden = false;
    audio.stopMusic();
    announce(`Game over. Final score ${score}.${isNewBest ? ' New high score!' : ''}`);
  }

  function pauseGame() {
    game.pause();
    els.overlayPause.hidden = false;
    audio.stopMusic();
    announce('Paused');
  }

  function resumeGame() {
    els.overlayPause.hidden = true;
    game.resume();
    audio.startMusic();
    announce('Resumed');
  }

  function goHome() {
    game.stop();
    audio.stopMusic();
    els.overlayPause.hidden = true;
    els.overlayGameover.hidden = true;
    showScreen('home');
    refreshHomeStats();
  }

  /* ---- Input: keyboard ---- */

  function onKeydown(e) {
    const key = e.key.toLowerCase();
    const dirMap = {
      arrowup: [0, -1], w: [0, -1],
      arrowdown: [0, 1], s: [0, 1],
      arrowleft: [-1, 0], a: [-1, 0],
      arrowright: [1, 0], d: [1, 0]
    };
    if (dirMap[key] && els.screenGame.hidden === false) {
      e.preventDefault();
      const [dx, dy] = dirMap[key];
      game.setDirection(dx, dy);
      return;
    }
    if (key === ' ' && !els.screenGame.hidden) {
      e.preventDefault();
      if (game.state === 'running') pauseGame();
      else if (game.state === 'paused') resumeGame();
    }
    if (key === 'f') toggleFullscreen();
  }

  /* ---- Input: touch / pointer ---- */

  function bindTouchControls() {
    $$('.dpad__btn[data-dir]').forEach(btn => {
      const dir = btn.dataset.dir;
      const map = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
      const fire = (e) => { e.preventDefault(); game.setDirection(...map[dir]); };
      btn.addEventListener('pointerdown', fire);
    });

    // Swipe-to-steer directly on the board.
    let sx = 0, sy = 0, tracking = false;
    els.board.addEventListener('touchstart', (e) => {
      const t = e.changedTouches[0];
      sx = t.clientX; sy = t.clientY; tracking = true;
    }, { passive: true });

    els.board.addEventListener('touchmove', (e) => {
      if (!tracking) return;
      e.preventDefault(); // prevent page scroll while swiping on the board
    }, { passive: false });

    els.board.addEventListener('touchend', (e) => {
      if (!tracking) return;
      tracking = false;
      const t = e.changedTouches[0];
      const dx = t.clientX - sx, dy = t.clientY - sy;
      if (Math.hypot(dx, dy) < 24) return; // ignore taps
      if (Math.abs(dx) > Math.abs(dy)) game.setDirection(dx > 0 ? 1 : -1, 0);
      else game.setDirection(0, dy > 0 ? 1 : -1);
    });
  }

  /* ---- Fullscreen ---- */

  function toggleFullscreen() {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen?.().catch(() => {});
    } else {
      document.exitFullscreen?.().catch(() => {});
    }
  }

  function onFullscreenChange() {
    const isFs = !!document.fullscreenElement;
    els.btnFullscreen.setAttribute('aria-pressed', String(isFs));
    $('.icon-fs-enter', els.btnFullscreen).hidden = isFs;
    $('.icon-fs-exit', els.btnFullscreen).hidden = !isFs;
  }

  /* ---- Settings wiring ---- */

  function applySettingsToUI() {
    els.toggleSfx.checked = settings.sfx;
    els.toggleMusic.checked = settings.music;
    els.toggleGrid.checked = settings.grid;
    els.toggleWrap.checked = settings.wrap;
    $(`input[name="difficulty"][value="${settings.difficulty}"]`).checked = true;
    updateSoundIcon();
  }

  function updateSoundIcon() {
    $('.icon-sound-on', els.btnSound).hidden = !settings.sfx;
    $('.icon-sound-off', els.btnSound).hidden = settings.sfx;
    els.btnSound.setAttribute('aria-pressed', String(settings.sfx));
  }

  /* ---- Visibility: auto-pause when the tab is hidden ---- */

  function onVisibilityChange() {
    if (document.hidden && game && game.state === 'running') pauseGame();
  }

  /* ---- Init ---- */

  function bindEvents() {
    els.btnPlay.addEventListener('click', startNewGame);
    els.btnHowto.addEventListener('click', () => openModal(els.howtoModal));
    els.btnCloseHowto.addEventListener('click', () => closeModal(els.howtoModal));
    els.howtoModal.addEventListener('click', (e) => { if (e.target === els.howtoModal) closeModal(els.howtoModal); });

    els.btnSettings.addEventListener('click', () => openModal(els.settingsModal));
    els.btnCloseSettings.addEventListener('click', () => closeModal(els.settingsModal));
    els.settingsModal.addEventListener('click', (e) => { if (e.target === els.settingsModal) closeModal(els.settingsModal); });

    els.btnHome.addEventListener('click', goHome);
    els.btnHomePaused.addEventListener('click', goHome);
    els.btnHomeGameover.addEventListener('click', goHome);

    els.btnPause.addEventListener('click', () => { audio.click(); pauseGame(); });
    els.btnResume.addEventListener('click', () => { audio.click(); resumeGame(); });
    els.btnRestartPaused.addEventListener('click', () => { audio.click(); startNewGame(); });
    els.btnPlayAgain.addEventListener('click', () => { audio.click(); startNewGame(); });

    els.btnSound.addEventListener('click', () => {
      settings.sfx = !settings.sfx;
      saveSettings();
      updateSoundIcon();
      audio.click();
    });

    els.btnFullscreen.addEventListener('click', toggleFullscreen);
    document.addEventListener('fullscreenchange', onFullscreenChange);

    els.toggleSfx.addEventListener('change', (e) => { settings.sfx = e.target.checked; saveSettings(); updateSoundIcon(); });
    els.toggleMusic.addEventListener('change', (e) => {
      settings.music = e.target.checked;
      saveSettings();
      audio.toggleMusic();
    });
    els.toggleGrid.addEventListener('change', (e) => { settings.grid = e.target.checked; saveSettings(); });
    els.toggleWrap.addEventListener('change', (e) => { settings.wrap = e.target.checked; saveSettings(); });

    els.btnResetData.addEventListener('click', () => {
      if (!confirm('Reset your high score and stats on this device? This cannot be undone.')) return;
      Storage.set(STORAGE_KEYS.highScore, 0);
      Storage.set(STORAGE_KEYS.gamesPlayed, 0);
      Storage.set(STORAGE_KEYS.bestLength, 3);
      refreshHomeStats();
    });

    $$('input[name="difficulty"]').forEach(r => r.addEventListener('change', () => audio.click()));

    document.addEventListener('keydown', onKeydown);
    document.addEventListener('visibilitychange', onVisibilityChange);
  }

  function init() {
    cacheEls();
    applySettingsToUI();
    refreshHomeStats();
    bindEvents();
    bindTouchControls();

    game = new SnakeGame(els.canvas);
    game.onScoreChange = handleScoreChange;
    game.onGameOver = handleGameOver;

    const ambientCanvas = $('#particles');
    if (ambientCanvas) new AmbientParticles(ambientCanvas);

    const heroCanvas = $('#heroSnake');
    const heroPath = $('#viperPath');
    if (heroCanvas && heroPath) heroSnake = new HeroSnake(heroCanvas, heroPath);
  }

  return { init };
})();

document.addEventListener('DOMContentLoaded', App.init);
