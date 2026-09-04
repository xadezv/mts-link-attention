'use strict';

let ctx = null;
const audio = () => (ctx = ctx && ctx.state !== 'closed' ? ctx : new AudioContext());

function tone(t0, freq, dur, vol, type) {
  const c = audio();
  const o = c.createOscillator(), g = c.createGain();
  o.type = type || 'sine';
  o.frequency.setValueAtTime(freq, t0);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol), t0 + 0.015);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g); g.connect(c.destination);
  o.start(t0); o.stop(t0 + dur + 0.02);
}

function sweep(t0, from, to, dur, vol) {
  const c = audio();
  const o = c.createOscillator(), g = c.createGain();
  o.type = 'sawtooth';
  o.frequency.setValueAtTime(from, t0);
  o.frequency.linearRampToValueAtTime(to, t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol), t0 + 0.03);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g); g.connect(c.destination);
  o.start(t0); o.stop(t0 + dur + 0.02);
}

function play(pattern, volume) {
  const c = audio();
  if (c.state === 'suspended') c.resume().catch(() => {});
  const v = Math.min(1, Math.max(0, volume == null ? 0.35 : volume));
  const t = c.currentTime + 0.02;

  switch (pattern) {
    case 'ok':
      tone(t, 880, 0.12, v * 0.5);
      tone(t + 0.13, 1175, 0.16, v * 0.5);
      break;
    case 'siren':
      for (let i = 0; i < 3; i++) {
        sweep(t + i * 0.42, 520, 1180, 0.2, v);
        sweep(t + i * 0.42 + 0.2, 1180, 520, 0.18, v);
      }
      break;
    case 'alert':
    default:
      for (let i = 0; i < 4; i++) tone(t + i * 0.24, i % 2 ? 784 : 1046, 0.17, v, 'square');
      break;
  }
}

chrome.runtime.onMessage.addListener((msg, _s, respond) => {
  if (!msg || msg.target !== 'offscreen') return;
  if (msg.type === 'play') {
    try { play(msg.pattern, msg.volume); respond && respond({ ok: true }); }
    catch (e) { respond && respond({ ok: false, error: String(e) }); }
    return true;
  }
});
