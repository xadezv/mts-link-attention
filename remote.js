(function () {
  'use strict';
  const VERSION = 3;
  if (window.__attnRemote) return;
  window.__attnRemote = VERSION;

  let cfg = { mode: 'auto', delayMin: 1500, delayMax: 5000, repeatAlertSec: 15,
              fireEnabled: false, fireMinMin: 3, fireMaxMin: 10,
              keepFocus: true, forceInvolvement: true, sound: true, desktopNotify: true };
  let rules = null;
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
  }


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


  function clickNow(source) {
    const btn = findConfirmButton(findRoot());
    if (!btn) return false;
    btn.click();
    stopAlert();
    log('нажал «' + btn.textContent.trim() + '»', source);
    send('clicked', { source: source + ':remote' });
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

  refreshCfg();
  setInterval(refreshCfg, 10000);
  new MutationObserver(tick).observe(document.documentElement, { childList: true, subtree: true });
  setInterval(tick, 1000);

  send('remote-alive', { version: VERSION });
  setInterval(() => send('remote-alive', { version: VERSION }), 20000);

  window.__attentionRemote = {
    status: () => ({ version: VERSION, rules, cfg, modalOpen: !!findRoot() }),
    click: () => clickNow('devtools')
  };
  log('активен');
})();
