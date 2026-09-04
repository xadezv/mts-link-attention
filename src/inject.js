(function () {
  'use strict';
  if (window.__attnInjected) return;
  window.__attnInjected = true;

  const CH = '__attn__';

  let cfg = { keepFocus: true, forceInvolvement: true };

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.ch !== CH || d.dir !== 'to-page') return;
    if (d.type === 'cfg') cfg = Object.assign(cfg, d.cfg || {});
  });

  const send = (type, payload) =>
    window.postMessage({ ch: CH, dir: 'to-ext', type, payload }, '*');

  const INVOLVEMENT_RE = /setUserInvolvementStatus/i;

  const CONFIRM_RE = /(checkpoint|attention|involvement.*confirm|confirm.*presence)/i;
  const FORCED_BODY = 'isFocused=true&isSoundEnabled=true&isVideoEnabled=true';

  const urlOf = (input) => {
    try {
      if (typeof input === 'string') return input;
      if (input instanceof URL) return input.href;
      if (input && typeof input.url === 'string') return input.url;
    } catch (_) {}
    return '';
  };

  function describeBody(body) {
    try {
      if (body == null) return '';
      if (typeof body === 'string') return body.slice(0, 300);
      if (body instanceof URLSearchParams) return body.toString().slice(0, 300);
      if (typeof FormData !== 'undefined' && body instanceof FormData) {
        return Array.from(body.entries()).map(([k, v]) => `${k}=${v}`).join('&').slice(0, 300);
      }
    } catch (_) {}
    return '[binary]';
  }

  const focusedTrue = (bodyStr) => /isFocused=true|"isFocused"\s*:\s*true/i.test(bodyStr || '');

  function report(via, sentBody, forced, t0, ok, status, error) {
    send('involvement', {
      via,
      forced: !!forced,
      focusedTrue: focusedTrue(sentBody),
      sentBody: (sentBody || '').slice(0, 160),
      ok: !!ok,
      status: status || 0,
      ms: Math.round(performance.now() - t0),
      error: error ? String(error).slice(0, 160) : null
    });
  }

  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      const url = urlOf(input);

      if (INVOLVEMENT_RE.test(url)) {
        const t0 = performance.now();
        let sentBody = describeBody(init && init.body);
        let call;

        try {
          if (cfg.forceInvolvement) {
            if (typeof input === 'string' || input instanceof URL) {
              const next = Object.assign({ method: 'POST' }, init || {});
              next.body = FORCED_BODY;
              sentBody = FORCED_BODY;
              call = origFetch.call(window, input, next);
            } else if (input && typeof input.url === 'string') {

              const req = new Request(input, { body: FORCED_BODY });
              sentBody = FORCED_BODY;
              call = origFetch.call(window, req);
            }
          }
        } catch (err) {
          console.warn('[attention] не смог подменить тело пинга', err);
        }

        if (!call) call = origFetch.apply(window, arguments);

        return call.then(
          (res) => { report('fetch', sentBody, cfg.forceInvolvement, t0, res.ok, res.status); return res; },
          (err) => { report('fetch', sentBody, cfg.forceInvolvement, t0, false, 0, err); throw err; }
        );
      }

      if (CONFIRM_RE.test(url)) {
        const t0 = performance.now();
        return origFetch.apply(window, arguments).then(
          (res) => {
            send('confirm-request', { url: url.slice(0, 160), ok: res.ok, status: res.status,
              ms: Math.round(performance.now() - t0) });
            return res;
          },
          (err) => {
            send('confirm-request', { url: url.slice(0, 160), ok: false, status: 0,
              error: String(err).slice(0, 160) });
            throw err;
          }
        );
      }

      return origFetch.apply(window, arguments);
    };
  }

  const XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype) {
    const origOpen = XHR.prototype.open;
    const origSend = XHR.prototype.send;

    XHR.prototype.open = function (method, url) {
      try {
        const u = String(url);
        this.__attnInvolvement = INVOLVEMENT_RE.test(u);
        this.__attnConfirm = !this.__attnInvolvement && CONFIRM_RE.test(u);
        this.__attnUrl = u;
      } catch (_) {}
      return origOpen.apply(this, arguments);
    };

    XHR.prototype.send = function (body) {
      if (this.__attnInvolvement || this.__attnConfirm) {
        const t0 = performance.now();
        const involvement = !!this.__attnInvolvement;
        let sentBody = describeBody(body);
        const url = this.__attnUrl || '';

        this.addEventListener('loadend', () => {
          const ok = this.status >= 200 && this.status < 300;
          if (involvement) report('xhr', sentBody, cfg.forceInvolvement, t0, ok, this.status);
          else send('confirm-request', { url: url.slice(0, 160), ok, status: this.status,
            ms: Math.round(performance.now() - t0) });
        }, { once: true });

        if (involvement && cfg.forceInvolvement) {
          sentBody = FORCED_BODY;
          return origSend.call(this, FORCED_BODY);
        }
      }
      return origSend.apply(this, arguments);
    };
  }

  try {
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => (cfg.keepFocus ? false : document.visibilityState === 'hidden')
    });
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => (cfg.keepFocus ? 'visible' : 'hidden')
    });
    Object.defineProperty(document, 'webkitHidden', {
      configurable: true,
      get: () => (cfg.keepFocus ? false : true)
    });
  } catch (err) {
    console.warn('[attention] visibility patch failed', err);
  }

  const origHasFocus = document.hasFocus.bind(document);
  document.hasFocus = function () { return cfg.keepFocus ? true : origHasFocus(); };

  const swallow = (ev) => {
    if (!cfg.keepFocus) return;
    ev.stopImmediatePropagation();
    ev.preventDefault();
  };
  window.addEventListener('blur', swallow, true);
  document.addEventListener('visibilitychange', swallow, true);
  document.addEventListener('webkitvisibilitychange', swallow, true);

  console.log('%c[attention] inject.js активен', 'color:#08f;font-weight:bold');
})();
