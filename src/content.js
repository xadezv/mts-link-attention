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
  let fireTimer = null;
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
      if (b.closest && b.closest('#__attention_overlay')) continue;
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


  const CSS = `
  :host { all: initial; }
  .wrap { position: fixed; right: 16px; bottom: 16px; z-index: 2147483600;
    font: 13px/1.45 -apple-system, "Segoe UI", Roboto, sans-serif; }
  .badge { width: 44px; height: 44px; border-radius: 50%; border: 0; cursor: pointer;
    color: #fff; font-size: 15px; font-weight: 700; background: #1c8a4a;
    box-shadow: 0 4px 14px rgba(0,0,0,.28); display: grid; place-items: center;
    transition: background .2s, transform .1s; }
  .badge:hover { transform: scale(1.06); }
  .badge.alert { background: #d23b3b; animation: pulse 1s infinite; }
  .badge.off { background: #6b7280; }
  @keyframes pulse { 50% { box-shadow: 0 0 0 10px rgba(210,59,59,.25); } }
  .panel { position: absolute; right: 0; bottom: 56px; width: 300px; border-radius: 12px;
    background: #fff; color: #16181d; box-shadow: 0 10px 40px rgba(0,0,0,.3);
    padding: 14px; display: none; }
  .panel.open { display: block; }
  @media (prefers-color-scheme: dark) {
    .panel { background: #1c1f26; color: #e8eaed; }
    .seg { background: #262a33; }
    .num { background: #14161b; color: #e8eaed; border-color: #333a45; }
  }
  h3 { margin: 0 0 10px; font-size: 14px; display: flex; justify-content: space-between; align-items: center; }
  .x { border: 0; background: none; cursor: pointer; color: #9aa0aa; font-size: 16px; line-height: 1; }
  .seg { display: flex; background: #f1f2f5; border-radius: 9px; padding: 3px; margin-bottom: 10px; }
  .seg button { flex: 1; border: 0; background: none; cursor: pointer; padding: 7px 4px;
    border-radius: 7px; font-size: 12px; color: inherit; }
  .seg button.on { background: #1c8a4a; color: #fff; font-weight: 600; }
  .row { display: flex; justify-content: space-between; gap: 8px; padding: 3px 0; font-size: 12px; }
  .row span { color: #6b7280; }
  .row b { font-weight: 600; }
  .good { color: #1c8a4a; } .bad { color: #d23b3b; }
  .sep { height: 1px; background: rgba(128,128,128,.22); margin: 10px 0; }
  label.t { display: flex; align-items: center; gap: 7px; padding: 4px 0; font-size: 12.5px; cursor: pointer; }
  .fire { display: flex; align-items: center; gap: 6px; font-size: 12px; color: #6b7280; padding: 2px 0 6px; }
  .num { width: 48px; padding: 3px 5px; border-radius: 5px; border: 1px solid #d8dbe0;
    background: #fff; color: #16181d; font: inherit; font-size: 12px; }
  .btns { display: flex; gap: 6px; margin-top: 10px; }
  .btns button { flex: 1; border: 0; border-radius: 8px; padding: 8px; cursor: pointer;
    font-size: 12px; font-weight: 600; background: #1c8a4a; color: #fff; }
  .btns button.ghost { background: rgba(128,128,128,.18); color: inherit; font-weight: 500; }
  .btns button:disabled { opacity: .45; cursor: default; }
  .hot { font-size: 11px; color: #6b7280; padding-top: 8px; }
  ul { list-style: none; margin: 8px 0 0; padding: 0; max-height: 96px; overflow-y: auto; }
  li { display: flex; gap: 6px; font-size: 11px; color: #6b7280; padding: 1px 0; }
  li.modal { color: #d23b3b; } li.click, li.ok { color: #1c8a4a; } li.fail { color: #d23b3b; }
  `;

  let host = null, ui = {}, stats = {};

  const node = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  const setCfg = (patch) => {
    cfg = Object.assign(cfg, patch);
    chrome.storage.sync.set(patch);
    paintUi();
  };

  function fireNow() {
    const b = findFireButton();
    if (!b) { log(WARN, 'кнопки «Огонёк» нет'); return false; }
    b.click();
    bg({ type: 'fire' });
    return true;
  }

  function buildUi() {
    host = document.createElement('div');
    host.id = '__attention_overlay';
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = CSS;

    const wrap = node('div', 'wrap');
    const badge = node('button', 'badge', '0');
    const panel = node('div', 'panel');

    const h = node('h3');
    h.append(node('span', null, 'Контроль присутствия'));
    const x = node('button', 'x', '×');
    x.addEventListener('click', () => panel.classList.remove('open'));
    h.append(x);

    const seg = node('div', 'seg');
    const bAuto = node('button', null, 'Жать само');
    const bNotify = node('button', null, 'Только звать');
    bAuto.addEventListener('click', () => setCfg({ mode: 'auto' }));
    bNotify.addEventListener('click', () => setCfg({ mode: 'notify' }));
    seg.append(bAuto, bNotify);

    const mkRow = (label) => {
      const r = node('div', 'row');
      r.append(node('span', null, label));
      const v = node('b', null, '—');
      r.append(v);
      return { row: r, value: v };
    };
    const rShows = mkRow('Отработано показов');
    const rPing = mkRow('Пинг присутствия');
    const rFires = mkRow('Огоньков');

    const mkToggle = (key, label) => {
      const l = node('label', 't');
      const i = document.createElement('input');
      i.type = 'checkbox';
      i.addEventListener('change', () => {
        setCfg({ [key]: i.checked });
        if (key === 'fireEnabled') scheduleFire();
      });
      l.append(i, document.createTextNode(label));
      return { label: l, input: i };
    };
    const tKeep = mkToggle('keepFocus', 'Держать вкладку активной');
    const tForce = mkToggle('forceInvolvement', 'Форсить isFocused');
    const tSound = mkToggle('sound', 'Звук');
    const tFire = mkToggle('fireEnabled', 'Жать «Огонёк» сам');

    const fireRow = node('div', 'fire');
    const nLo = node('input'), nHi = node('input');
    for (const n of [nLo, nHi]) {
      n.className = 'num'; n.type = 'number'; n.min = '0.5'; n.max = '180'; n.step = '0.5';
    }
    const commitFire = () => {
      let a = Math.max(0.5, +nLo.value || 3), b = Math.max(0.5, +nHi.value || 10);
      if (b < a) b = a;
      nLo.value = a; nHi.value = b;
      setCfg({ fireMinMin: a, fireMaxMin: b });
      scheduleFire();
    };
    nLo.addEventListener('change', commitFire);
    nHi.addEventListener('change', commitFire);
    const fireNext = node('span', null, '');
    fireRow.append(document.createTextNode('случайно раз в'), nLo,
                   document.createTextNode('–'), nHi,
                   document.createTextNode('мин'), fireNext);

    const btns = node('div', 'btns');
    const bConfirm = node('button', null, 'Подтвердить');
    bConfirm.addEventListener('click', () => { clickNow('overlay'); setTimeout(paintUi, 300); });
    const bFire = node('button', 'ghost', '\u{1F525}');
    bFire.addEventListener('click', () => { fireNow(); setTimeout(paintUi, 300); });
    const bSync = node('button', 'ghost', 'Обновить');
    bSync.addEventListener('click', () => { bg({ type: 'sync-rules' }); setTimeout(pullStats, 900); });
    btns.append(bConfirm, bFire, bSync);

    const hot = node('div', 'hot', '');
    const list = node('ul');

    panel.append(h, seg, rShows.row, rPing.row, rFires.row, node('div', 'sep'),
                 tKeep.label, tForce.label, tSound.label, tFire.label, fireRow,
                 btns, hot, list);

    badge.addEventListener('click', () => { panel.classList.toggle('open'); pullStats(); });

    wrap.append(panel, badge);
    shadow.append(style, wrap);
    (document.body || document.documentElement).append(host);

    ui = { badge, panel, bAuto, bNotify, rShows, rPing, rFires,
           tKeep, tForce, tSound, tFire, nLo, nHi, fireNext, bConfirm, hot, list };
  }

  function pullStats() {
    chrome.storage.local.get({
      clicked: 0, shows: 0, fires: 0, nextFireAt: 0,
      lastInvolvementAt: 0, lastInvolvementOk: false, lastInvolvementStatus: 0,
      lastInvolvementFocused: false, remoteAliveAt: 0, remoteVersion: null,
      remoteState: null, rules: null, log: []
    }, (d) => { stats = d; paintUi(); });
  }

  function paintUi() {
    if (!ui.badge) return;
    const open = !!findRoot();

    ui.badge.className = 'badge' + (open ? ' alert' : (rules.rulesVersion ? '' : ' off'));
    ui.badge.textContent = open ? '!' : String(stats.clicked || 0);
    ui.badge.title = open ? 'Нужно подтвердить присутствие' : 'Контроль присутствия';
    ui.bConfirm.disabled = !open;

    ui.bAuto.className = cfg.mode === 'auto' ? 'on' : '';
    ui.bNotify.className = cfg.mode === 'auto' ? '' : 'on';

    const shows = stats.shows | 0, clicked = stats.clicked | 0;
    ui.rShows.value.textContent = shows
      ? clicked + ' / ' + shows + ' · ' + Math.round((clicked / shows) * 100) + '%' : '0 / 0';
    ui.rShows.value.className = shows && clicked >= shows ? 'good' : shows ? 'bad' : '';

    if (!stats.lastInvolvementAt) {
      ui.rPing.value.textContent = '—';
      ui.rPing.value.className = '';
    } else {
      const good = stats.lastInvolvementOk && stats.lastInvolvementFocused;
      const sec = Math.round((Date.now() - stats.lastInvolvementAt) / 1000);
      ui.rPing.value.textContent = (sec < 60 ? sec + ' с назад' : Math.round(sec / 60) + ' мин назад') +
        ' · ' + (stats.lastInvolvementOk ? stats.lastInvolvementStatus : 'ошибка');
      ui.rPing.value.className = good ? 'good' : 'bad';
    }

    ui.rFires.value.textContent = String(stats.fires || 0);

    ui.tKeep.input.checked = !!cfg.keepFocus;
    ui.tForce.input.checked = !!cfg.forceInvolvement;
    ui.tSound.input.checked = !!cfg.sound;
    ui.tFire.input.checked = !!cfg.fireEnabled;
    if (document.activeElement !== ui.nLo) ui.nLo.value = cfg.fireMinMin;
    if (document.activeElement !== ui.nHi) ui.nHi.value = cfg.fireMaxMin;

    if (!cfg.fireEnabled) ui.fireNext.textContent = '';
    else if (stats.nextFireAt) {
      const left = Math.round((stats.nextFireAt - Date.now()) / 1000);
      ui.fireNext.textContent = left > 0
        ? '· через ' + (left < 90 ? left + ' с' : Math.round(left / 60) + ' мин') : '';
    }

    const live = stats.remoteAliveAt && Date.now() - stats.remoteAliveAt < 60000;
    const rv = stats.rules ? 'правила v' + stats.rules.rulesVersion : 'правила встроенные';
    ui.hot.textContent = live
      ? rv + ' · горячие правки включены'
      : rv + ' · горячие правки выключены (включи «Разрешить пользовательские скрипты»)';

    ui.list.textContent = '';
    for (const e of (stats.log || []).slice(0, 6)) {
      const li = node('li', e.kind);
      li.append(node('time', null, new Date(e.t).toLocaleTimeString('ru-RU')),
                node('span', null, e.text));
      ui.list.append(li);
    }
  }

  function mountUi() {
    if (host && document.contains(host)) return;
    if (!document.body) return;
    buildUi();
    pullStats();
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
  setInterval(() => { mountUi(); paintUi(); }, 1000);
  setInterval(pullStats, 5000);
  mountUi();
  tick();

  chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
    if (!msg || !msg.type) return;
    if (msg.type === 'click-now') { respond({ ok: clickNow(msg.source || 'manual') }); return true; }
    if (msg.type === 'fire-now') { respond({ ok: fireNow() }); return true; }
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
    panel: () => ui.panel && ui.panel.classList.toggle('open'),
    click: () => clickNow('devtools')
  };

  if (window.top === window) bg({ type: 'page-load' });

  log(INFO, 'content.js активен. __attention.status() / __attention.click()');
})();
