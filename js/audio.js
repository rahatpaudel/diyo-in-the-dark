/**
 * Small HTMLAudio manager for ambience, footsteps, the matchstick ceremony,
 * and the ending theme.
 *
 * Playback starts from the "Strike the Match" click, so every later sound is
 * already inside a user-gesture-initiated session. Volumes are faded in the
 * frame loop instead of switched abruptly.
 */
const ROOT = 'sounds/';

const FOREST_VOLUME = 0.3;
const FOREST_DUCKED = 0.09;
const WIND_VOLUME = 0.55;
const STEP_VOLUME = 0.24;
const WIN_VOLUME = 0.6;

function audioTrack(path, loop) {
  const audio = new Audio(ROOT + path);
  audio.loop = !!loop;
  audio.preload = 'auto';
  audio.volume = 0;
  return audio;
}

function play(audio, volume) {
  try {
    audio.currentTime = 0;
    audio.volume = volume;
    const promise = audio.play();
    if (promise && typeof promise.catch === 'function') {
      promise.catch(() => {});
    }
  } catch (e) {
    // A missing or unsupported file must never break the game.
  }
}

export function createAudio() {
  const forest = audioTrack('ambience/forest.ogg', true);
  const wind = audioTrack('ambience/wind.ogg', true);
  const win = audioTrack('win.wav', false);
  const strike = audioTrack('effects/matchstick/strike.wav', false);
  const strikeLight = audioTrack('effects/matchstick/strike_and_light.wav', false);

  const footsteps = [];
  for (let i = 1; i <= 8; i++) {
    footsteps.push(audioTrack('effects/footsteps/' + i + '.wav', false));
  }

  let started = false;
  let won = false;
  let forestTarget = 0;
  let windTarget = 0;
  let stepTimer = 0;

  function fade(current, target, dt, speed) {
    return current + (target - current) * (1 - Math.exp(-dt * speed));
  }

  /** Called from the start button so the first play() has a user gesture. */
  function start() {
    if (started) return;
    started = true;
    forestTarget = FOREST_VOLUME;
    const promise = forest.play();
    if (promise && typeof promise.catch === 'function') {
      promise.catch(() => {});
    }
  }

  function startWind() {
    if (!started) return;
    forestTarget = FOREST_DUCKED;
    windTarget = WIND_VOLUME;
    if (wind.paused) {
      wind.currentTime = 0;
      const promise = wind.play();
      if (promise && typeof promise.catch === 'function') {
        promise.catch(() => {});
      }
    }
  }

  function stopWind() {
    windTarget = 0;
    forestTarget = won ? FOREST_DUCKED : FOREST_VOLUME;
  }

  function playStrike() {
    if (!started) return;
    play(strike, 0.5);
  }

  function playStrikeLight() {
    if (!started) return;
    play(strikeLight, 0.58);
  }

  function playWin() {
    if (!started) return;
    won = true;
    forestTarget = FOREST_DUCKED;
    windTarget = 0;
    play(win, WIN_VOLUME);
  }

  function update(dt, walking) {
    if (!started) return;

    forest.volume = fade(
      forest.volume,
      forestTarget,
      dt,
      forestTarget > forest.volume ? 0.8 : 2.0
    );
    wind.volume = fade(
      wind.volume,
      windTarget,
      dt,
      windTarget > wind.volume ? 0.55 : 2.2
    );

    if (windTarget === 0 && wind.volume < 0.01 && !wind.paused) {
      wind.pause();
    }

    if (!walking) {
      stepTimer = 0;
      return;
    }

    stepTimer -= dt;
    if (stepTimer > 0) return;

    const step = footsteps[Math.floor(Math.random() * footsteps.length)];
    try {
      step.currentTime = 0;
      step.playbackRate = 0.92 + Math.random() * 0.16;
      step.volume = STEP_VOLUME + Math.random() * 0.06;
      const promise = step.play();
      if (promise && typeof promise.catch === 'function') {
        promise.catch(() => {});
      }
    } catch (e) {
      // Ignore a single missed footstep.
    }

    stepTimer = 0.46 + Math.random() * 0.1;
  }

  return {
    start,
    startWind,
    stopWind,
    playStrike,
    playStrikeLight,
    playWin,
    update
  };
}
