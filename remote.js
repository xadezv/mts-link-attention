(function () {
  'use strict';
  const VERSION = 3;
  if (window.__attnRemote) return;
  window.__attnRemote = VERSION;

  let cfg = { mode: 'auto', delayMin: 1500, delayMax: 5000, repeatAlertSec: 15,
              fireEnabled: false, fireMinMin: 3, fireMaxMin: 10,
              keepFocus: true, forceInvolvement: true, sound: true, desktopNotify: true };
  let rules = null;
  let stats = {};
  let pending = false, lastRoot = null, alertTimer = null;

  const send = (type, payload, cb) => {
    try { chrome.runtime.sendMessage({ type, payload }, (r) => { void chrome.runtime.lastError; cb && cb(r); }); }
    catch (_) {}
  };
  const log = (...a) => console.log('%c[attention v' + VERSION + ']', 'color:#a0f;font-weight:bold', ...a);

  function refreshCfg() {
    send('get-cfg', null, (res) => {
      if (res && res.cfg) cfg = Object.assign(cfg, res.cfg);
      if (res && res.rules) rules = res.rules;
    });
    send('get-stats', null, (res) => { if (res) stats = res; });
  }

  const setCfg = (patch) => {
    cfg = Object.assign(cfg, patch);
    send('set-cfg', patch);
    paint();
  };

  const pick = (list) => {
    for (const sel of list || []) {
      try { const el = document.querySelector(sel); if (el) return el; } catch (_) {}
    }
    return null;
  };

  const findRoot = () => (rules ? pick(rules.modalSelectors) : null);
  const findSuccess = () => (rules ? pick(rules.successSelectors) : null);

  const readTimer = (root) => {
    if (!root || !rules) return null;
    for (const sel of rules.timerSelectors || []) {
      try { const el = root.querySelector(sel); if (el) return el.textContent.trim(); } catch (_) {}
    }
    return null;
  };

  function findConfirmButton(root) {
    if (!rules) return null;
    const texts = (rules.confirmButtonTexts || []).map((x) => String(x).toLowerCase());
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
        if (texts.some((x) => t.includes(x))) return b;
      }
    }
    return null;
  }

  function findFireButton() {
    const f = (rules && rules.fire) || {};
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
      if (host && host.contains(b)) continue;
      const t = (b.textContent || '') + ' ' + (b.getAttribute('aria-label') || '') +
                ' ' + (b.getAttribute('title') || '');
      if (marks.some((mk) => t.includes(mk))) return b;
      if (labelRe && labelRe.test(t)) return b;
    }
    return null;
  }

  function clickNow(source) {
    const btn = findConfirmButton(findRoot());
    if (!btn) return false;
    btn.click();
    stopAlert();
    log('нажал «' + btn.textContent.trim() + '»', source);
    send('clicked', { source: source + ':remote' });
    return true;
  }

  function fireNow() {
    const b = findFireButton();
    if (!b) { log('кнопки «Огонёк» нет'); return false; }
    b.click();
    send('fire');
    return true;
  }

  function scheduleClick() {
    if (pending) return;
    pending = true;
    const lo = Math.max(0, cfg.delayMin | 0), hi = Math.max(lo, cfg.delayMax | 0);
    setTimeout(() => {
      if (findRoot()) clickNow('auto');
      setTimeout(() => { pending = false; }, 1200);
    }, Math.round(lo + Math.random() * (hi - lo)));
  }

  let fireTimer = null;
  function scheduleFire() {
    clearTimeout(fireTimer);
    if (!cfg.fireEnabled) return;
    const lo = Math.max(0.5, +cfg.fireMinMin || 3) * 60000;
    const hi = Math.max(lo, (+cfg.fireMaxMin || 10) * 60000);
    const delay = Math.round(lo + Math.random() * (hi - lo));
    nextFireAt = Date.now() + delay;
    fireTimer = setTimeout(() => { fireNow(); scheduleFire(); }, delay);
  }
  let nextFireAt = 0;

  function startAlert() {
    stopAlert();
    alertTimer = setInterval(() => {
      const root = findRoot();
      if (!root) return stopAlert();
      send('modal-remind', { timer: readTimer(root) });
    }, Math.max(5, cfg.repeatAlertSec | 0) * 1000);
  }
  const stopAlert = () => { if (alertTimer) { clearInterval(alertTimer); alertTimer = null; } };

  function tick() {
    if (!rules) return;
    const ok = findSuccess();
    if (ok && !ok.__attnSeen) { ok.__attnSeen = true; send('success'); }

    const root = findRoot();
    if (!root) { if (lastRoot) { lastRoot = null; pending = false; stopAlert(); } return; }

    if (lastRoot !== root) {
      lastRoot = root;
      const timer = readTimer(root);
      log('контроль присутствия' + (timer ? ' — ' + timer : ''));
      send('modal', { timer, mode: cfg.mode });
      if (cfg.mode !== 'auto') startAlert();
    }
    if (cfg.mode === 'auto') scheduleClick();
  }

  let host = null, shadow = null, ui = {};

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
    .row b { color: #e8eaed; }
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
  ul { list-style: none; margin: 8px 0 0; padding: 0; max-height: 96px; overflow-y: auto; }
  li { display: flex; gap: 6px; font-size: 11px; color: #6b7280; padding: 1px 0; }
  li.modal { color: #d23b3b; } li.click, li.ok { color: #1c8a4a; } li.fail { color: #d23b3b; }
  `;

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function buildUi() {
    host = document.createElement('div');
    host.id = '__attention_overlay';
    shadow = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = CSS;

    const wrap = el('div', 'wrap');
    const badge = el('button', 'badge', '0');
    const panel = el('div', 'panel');

    const h = el('h3');
    h.append(el('span', null, 'Контроль присутствия'));
    const x = el('button', 'x', '×');
    x.addEventListener('click', () => panel.classList.remove('open'));
    h.append(x);

    const seg = el('div', 'seg');
    const bAuto = el('button', null, 'Жать само');
    const bNotify = el('button', null, 'Только звать');
    bAuto.addEventListener('click', () => setCfg({ mode: 'auto' }));
    bNotify.addEventListener('click', () => setCfg({ mode: 'notify' }));
    seg.append(bAuto, bNotify);

    const mkRow = (label) => {
      const r = el('div', 'row');
      r.append(el('span', null, label));
      const v = el('b', null, '—');
      r.append(v);
      return { row: r, value: v };
    };
    const rShows = mkRow('Отработано показов');
    const rPing = mkRow('Пинг присутствия');
    const rFires = mkRow('Огоньков');

    const mkToggle = (key, label) => {
      const l = el('label', 't');
      const i = document.createElement('input');
      i.type = 'checkbox';
      i.addEventListener('change', () => { setCfg({ [key]: i.checked }); if (key === 'fireEnabled') scheduleFire(); });
      l.append(i, document.createTextNode(label));
      return { label: l, input: i };
    };
    const tKeep = mkToggle('keepFocus', 'Держать вкладку активной');
    const tForce = mkToggle('forceInvolvement', 'Форсить isFocused');
    const tSound = mkToggle('sound', 'Звук');
    const tFire = mkToggle('fireEnabled', 'Жать «Огонёк» сам');

    const fireRow = el('div', 'fire');
    const nLo = el('input'), nHi = el('input');
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
    const fireNext = el('span', null, '');
    fireRow.append(document.createTextNode('случайно раз в'), nLo,
                   document.createTextNode('–'), nHi,
                   document.createTextNode('мин'), fireNext);

    const btns = el('div', 'btns');
    const bConfirm = el('button', null, 'Подтвердить');
    bConfirm.addEventListener('click', () => { clickNow('overlay'); setTimeout(paint, 300); });
    const bFire = el('button', 'ghost', '\u{1F525}');
    bFire.addEventListener('click', () => { fireNow(); setTimeout(paint, 300); });
    const bSync = el('button', 'ghost', 'Обновить');
    bSync.addEventListener('click', () => { send('sync-rules'); setTimeout(refreshCfg, 800); });
    btns.append(bConfirm, bFire, bSync);

    const list = el('ul');

    panel.append(h, seg, rShows.row, rPing.row, rFires.row, el('div', 'sep'),
                 tKeep.label, tForce.label, tSound.label, tFire.label, fireRow,
                 btns, list);

    badge.addEventListener('click', () => {
      panel.classList.toggle('open');
      refreshCfg();
      paint();
    });

    wrap.append(panel, badge);
    shadow.append(style, wrap);
    (document.body || document.documentElement).append(host);

    ui = { badge, panel, bAuto, bNotify, rShows, rPing, rFires,
           tKeep, tForce, tSound, tFire, nLo, nHi, fireNext, bConfirm, list };
  }

  function paint() {
    if (!ui.badge) return;
    const root = findRoot();
    const open = !!root;

    ui.badge.className = 'badge' + (open ? ' alert' : (rules ? '' : ' off'));
    ui.badge.textContent = open ? '!' : String(stats.clicked || 0);
    ui.badge.title = open ? 'Контроль присутствия — нужно подтвердить' : 'Контроль присутствия';
    ui.bConfirm.disabled = !open;

    ui.bAuto.className = cfg.mode === 'auto' ? 'on' : '';
    ui.bNotify.className = cfg.mode === 'auto' ? '' : 'on';

    const shows = stats.shows | 0, clicked = stats.clicked | 0;
    ui.rShows.value.textContent = shows ? clicked + ' / ' + shows + ' · ' +
      Math.round((clicked / shows) * 100) + '%' : '0 / 0';
    ui.rShows.value.className = shows && clicked >= shows ? 'good' : shows ? 'bad' : '';

    if (!stats.lastInvolvementAt) {
      ui.rPing.value.textContent = '—';
      ui.rPing.value.className = '';
    } else {
      const good = stats.lastInvolvementOk && stats.lastInvolvementFocused;
      const s = Math.round((Date.now() - stats.lastInvolvementAt) / 1000);
      ui.rPing.value.textContent = (s < 60 ? s + ' с назад' : Math.round(s / 60) + ' мин назад') +
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
    else if (nextFireAt) {
      const left = Math.round((nextFireAt - Date.now()) / 1000);
      ui.fireNext.textContent = left > 0
        ? '· через ' + (left < 90 ? left + ' с' : Math.round(left / 60) + ' мин') : '';
    }

    ui.list.textContent = '';
    for (const e of stats.log || []) {
      const li = el('li', e.kind);
      li.append(el('time', null, new Date(e.t).toLocaleTimeString('ru-RU')),
                el('span', null, e.text));
      ui.list.append(li);
    }
  }

  function mountUi() {
    if (host && document.contains(host)) return;
    if (!document.body) return;
    buildUi();
    paint();
  }

  refreshCfg();
  setInterval(refreshCfg, 10000);
  setInterval(() => { mountUi(); paint(); }, 1000);
  new MutationObserver(tick).observe(document.documentElement, { childList: true, subtree: true });
  setInterval(tick, 1000);
  mountUi();
  scheduleFire();

  send('remote-alive', { version: VERSION });
  setInterval(() => send('remote-alive', { version: VERSION }), 20000);

  window.__attentionRemote = {
    status: () => ({ version: VERSION, rules, cfg, stats, modalOpen: !!findRoot() }),
    click: () => clickNow('devtools'),
    fire: () => fireNow(),
    panel: () => ui.panel && ui.panel.classList.toggle('open')
  };
  log('активен, панель в правом нижнем углу');
})();
