(function () {
  'use strict';

  const CH = '__attn__';
  const DEFAULTS = {
    mode: 'auto',
    delayMin: 1500,
    delayMax: 5000,
    sound: true,
    desktopNotify: true,
    repeatAlertSec: 15,
    keepFocus: true,
    forceInvolvement: true,
    fireEnabled: false,
    fireMinMin: 3,
    fireMaxMin: 10
  };
  let cfg = Object.assign({}, DEFAULTS);

  const TAG = '%c[attention]';
  const OK = 'color:#0a0;font-weight:bold';
  const WARN = 'color:#e80;font-weight:bold';
  const INFO = 'color:#08f;font-weight:bold';
  const ts = () => new Date().toLocaleTimeString('ru-RU');
  const log = (css, ...a) => console.log(TAG + ' ' + ts(), css, ...a);

  const FALLBACK_RULES = {
    rulesVersion: 0,
    modalSelectors: ['[class*="AttentionControlModal__root"]', '[data-testid^="AttentionControlModal"]'],
    successSelectors: ['[class*="AttentionControlSuccessModal__root"]'],
    timerSelectors: ['[class*="AttentionControlModal__timer"]'],
    confirmButtonTexts: ['подтверждаю', 'confirm'],
    buttonSearchDepth: 5,
    involvementRe: 'setUserInvolvementStatus',
    confirmRe: '(checkpoint|attention|involvement.*confirm|confirm.*presence)',
    forcedBody: 'isFocused=true&isSoundEnabled=true&isVideoEnabled=true'
  };
  let rules = FALLBACK_RULES;
  let pending = false;
  let lastRoot = null;
  let alertTimer = null;

  const pushCfgToPage = () =>
    window.postMessage({ ch: CH, dir: 'to-page', type: 'cfg', cfg, rules }, '*');

  function applyRules(r) {
    if (r && Array.isArray(r.modalSelectors) && r.modalSelectors.length) {
      rules = Object.assign({}, FALLBACK_RULES, r);
      log(INFO, 'правила детекта v' + rules.rulesVersion);
    }
    pushCfgToPage();
  }

  let remoteAliveAt = 0;
  const remoteFresh = () => Date.now() - remoteAliveAt < 60000;

  chrome.storage.local.get({ rules: null, remoteAliveAt: 0 }, (d) => {
    remoteAliveAt = d.remoteAliveAt || 0;
    applyRules(d.rules);
  });

  chrome.storage.sync.get(DEFAULTS, (stored) => {
    cfg = Object.assign({}, DEFAULTS, stored);
    pushCfgToPage();
    scheduleFire();
    log(INFO, 'режим:', cfg.mode === 'auto' ? 'автоподтверждение' : 'только уведомление');
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.remoteAliveAt) {
      const was = remoteFresh();
      remoteAliveAt = changes.remoteAliveAt.newValue || 0;
      if (!was && remoteFresh()) log(INFO, 'работает удалённый скрипт — встроенный детект в пассиве');
    }
    if (area === 'local' && changes.rules) { applyRules(changes.rules.newValue); return; }
    if (area !== 'sync') return;
    const fireTouched = ['fireEnabled', 'fireMinMin', 'fireMaxMin'].some((k) => k in changes);
    for (const k of Object.keys(changes)) cfg[k] = changes[k].newValue;
    pushCfgToPage();
    if (fireTouched) scheduleFire();
  });

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.ch !== CH || d.dir !== 'to-ext') return;
    if (d.type === 'involvement') bg({ type: 'involvement', payload: d.payload });
  });

  const bg = (msg) => {
    try { chrome.runtime.sendMessage(msg, () => void chrome.runtime.lastError); }
    catch (_) {  }
  };

  function beep(times) {
    if (!cfg.sound) return;
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      for (let i = 0; i < (times || 1); i++) {
        const t0 = ctx.currentTime + i * 0.22;
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.type = 'sine';
        o.frequency.setValueAtTime(i % 2 ? 660 : 880, t0);
        g.gain.setValueAtTime(0.09, t0);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.18);
        o.connect(g); g.connect(ctx.destination);
        o.start(t0); o.stop(t0 + 0.19);
      }
      setTimeout(() => ctx.close().catch(() => {}), 1200);
    } catch (_) {  }
  }

  const pick = (list) => {
    for (const sel of list || []) {
      try { const el = document.querySelector(sel); if (el) return el; } catch (_) {}
    }
    return null;
  };

  const findRoot = () => pick(rules.modalSelectors);
  const findSuccess = () => pick(rules.successSelectors);

  const readTimer = (root) => {
    if (!root) return null;
    for (const sel of rules.timerSelectors || []) {
      try { const el = root.querySelector(sel); if (el) return el.textContent.trim(); } catch (_) {}
    }
    return null;
  };

  function findConfirmButton(root) {

    const scopes = [];
    if (root) {
      scopes.push(root);
      let p = root;
      const depth = rules.buttonSearchDepth || 5;
      for (let i = 0; i < depth && p.parentElement; i++) { p = p.parentElement; scopes.push(p); }
    }
    scopes.push(document);
    for (const scope of scopes) {
      for (const b of scope.querySelectorAll('button')) {
        const t = (b.textContent || '').trim().toLowerCase();
        if (!t || b.disabled || b.offsetParent === null) continue;
        if ((rules.confirmButtonTexts || []).some((x) => t.includes(String(x).toLowerCase()))) return b;
      }
    }
    return null;
  }

  function clickNow(source) {
    const btn = findConfirmButton(findRoot());
    if (!btn) { log(WARN, 'кнопка «Подтверждаю» не найдена'); return false; }
    btn.click();
    stopAlert();
    log(OK, `нажал «${btn.textContent.trim()}» (${source})`);
    bg({ type: 'clicked', payload: { source } });
    return true;
  }

  function scheduleClick() {
    if (pending) return;
    pending = true;
    const lo = Math.max(0, cfg.delayMin | 0);
    const hi = Math.max(lo, cfg.delayMax | 0);
    const delay = Math.round(lo + Math.random() * (hi - lo));
    log(INFO, `подтверждаю через ${delay} мс`);
    setTimeout(() => {
      if (findRoot()) clickNow('auto');
      else log(WARN, 'модалку закрыли раньше — клик отменён');
      setTimeout(() => { pending = false; }, 1200);
    }, delay);
  }

  function startAlert() {
    stopAlert();
    const sec = Math.max(5, cfg.repeatAlertSec | 0);
    alertTimer = setInterval(() => {
      const root = findRoot();
      if (!root) return stopAlert();
      bg({ type: 'modal-remind', payload: { timer: readTimer(root) } });
    }, sec * 1000);
  }
  const stopAlert = () => { if (alertTimer) { clearInterval(alertTimer); alertTimer = null; } };

  let fireTimer = null;

  function findFireButton() {
    const f = rules.fire || {};
    for (const sel of f.selectors || []) {
      try {
        const el = document.querySelector(sel);
        if (el && el.offsetParent !== null && !el.disabled) return el;
      } catch (_) {}
    }
    const marks = f.textMatches || ['\u{1F525}'];
    const labelRe = f.labelRe ? new RegExp(f.labelRe, 'i') : null;
    for (const b of document.querySelectorAll('button,[role="button"]')) {
      if (b.disabled || b.offsetParent === null) continue;
      const t = (b.textContent || '') + ' ' + (b.getAttribute('aria-label') || '') +
                ' ' + (b.getAttribute('title') || '');
      if (marks.some((mk) => t.includes(mk))) return b;
      if (labelRe && labelRe.test(t)) return b;
    }
    return null;
  }

  function scheduleFire() {
    clearTimeout(fireTimer);
    if (!cfg.fireEnabled) {
      try { chrome.storage.local.set({ nextFireAt: 0 }); } catch (_) {}
      return;
    }
    const lo = Math.max(0.5, +cfg.fireMinMin || 3) * 60000;
    const hi = Math.max(lo, (+cfg.fireMaxMin || 10) * 60000);
    const delay = Math.round(lo + Math.random() * (hi - lo));
    try { chrome.storage.local.set({ nextFireAt: Date.now() + delay }); } catch (_) {}
    log(INFO, 'следующий «Огонёк» через ' + Math.round(delay / 60000) + ' мин');
    fireTimer = setTimeout(() => {
      const b = findFireButton();
      if (b) {
        b.click();
        log(OK, 'нажал «Огонёк»');
        bg({ type: 'fire' });
      } else {
        log(WARN, 'кнопки «Огонёк» на странице нет');
      }
      scheduleFire();
    }, delay);
  }

  function tick() {
    if (remoteFresh()) return;
    const ok = findSuccess();
    if (ok && !ok.__attnSeen) {
      ok.__attnSeen = true;
      log(OK, 'подтверждено — «Отлично. Рады, что вы с нами!»');
      bg({ type: 'success' });
    }

    const root = findRoot();
    if (!root) {
      if (lastRoot) { lastRoot = null; pending = false; stopAlert(); }
      return;
    }

    if (lastRoot !== root) {
      lastRoot = root;
      const timer = readTimer(root);
      log(WARN, 'КОНТРОЛЬ ПРИСУТСТВИЯ' + (timer ? ` — осталось ${timer}` : ''));
      bg({ type: 'modal', payload: { timer, mode: cfg.mode } });
      if (cfg.mode !== 'auto') startAlert();
    }

    if (cfg.mode === 'auto') scheduleClick();
  }

  new MutationObserver(tick).observe(document.documentElement, { childList: true, subtree: true });
  setInterval(tick, 1000);
  tick();

  chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
    if (!msg || !msg.type) return;
    if (msg.type === 'click-now') { respond({ ok: clickNow(msg.source || 'manual') }); return true; }
    if (msg.type === 'fire-now') {
      const b = findFireButton();
      if (b) { b.click(); bg({ type: 'fire' }); }
      respond({ ok: !!b });
      return true;
    }
    if (msg.type === 'beep') { beep(msg.pattern === 'ok' ? 1 : 3); respond({ ok: true }); return true; }
    if (msg.type === 'probe') {
      const root = findRoot();
      respond({ ok: true, modalOpen: !!root, timer: readTimer(root), mode: cfg.mode,
                remote: remoteFresh(), rulesVersion: rules.rulesVersion });
      return true;
    }
  });

  window.__attention = {
    status: () => ({ modalOpen: !!findRoot(), timer: readTimer(findRoot()), pending, cfg, rules }),
    click: () => clickNow('devtools')
  };

  if (window.top === window) bg({ type: 'page-load' });

  log(INFO, 'content.js активен. __attention.status() / __attention.click()');
})();
