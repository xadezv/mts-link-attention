'use strict';

const DEFAULTS = {
  mode: 'auto', delayMin: 1500, delayMax: 5000,
  sound: true, soundVolume: 0.35, desktopNotify: true, repeatAlertSec: 15,
  keepFocus: true, forceInvolvement: true,
  fireEnabled: false, fireMinMin: 3, fireMaxMin: 10
};

const LOCAL_KEYS = {
  clicked: 0, shows: 0, lastClickAt: 0, lastInvolvementAt: 0,
  lastInvolvementOk: false, lastInvolvementStatus: 0, lastInvolvementFocused: false,
  lastInvolvementMs: 0, pingOk: 0, pingFail: 0, log: [], fires: 0, nextFireAt: 0,
  rules: null, rulesSource: null, rulesError: null,
  remoteState: null, remoteVersion: null, remoteAliveAt: 0, updateAvailable: null,
  ui: null
};

let cfg = Object.assign({}, DEFAULTS);
let local = Object.assign({}, LOCAL_KEYS);
let tabState = { modalOpen: false, timer: null, ok: false };
let schema = null;

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

const hhmmss = (t) => new Date(t).toLocaleTimeString('ru-RU');

function ago(t) {
  if (!t) return '—';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return s + ' с назад';
  if (s < 3600) return Math.round(s / 60) + ' мин назад';
  return hhmmss(t);
}

const save = (patch) => chrome.storage.sync.set(patch);

function sources(name) {
  const d = local;
  switch (name) {
    case 'ratio': {
      const shows = d.shows | 0, clicked = d.clicked | 0;
      return {
        text: shows ? `${clicked} / ${shows} · ${Math.round((clicked / shows) * 100)}%` : '0 / 0',
        cls: shows && clicked >= shows ? 'good' : shows ? 'bad' : ''
      };
    }
    case 'lastClick': return { text: ago(d.lastClickAt) };
    case 'fires':     return { text: String(d.fires | 0) };
    case 'ping': {
      if (!d.lastInvolvementAt) return { text: '—' };
      const good = d.lastInvolvementOk && d.lastInvolvementFocused;
      return { text: ago(d.lastInvolvementAt), cls: good ? 'good' : 'bad' };
    }
    case 'pingDetail': {
      if (!d.lastInvolvementAt) return { text: 'пингов ещё не было' };
      const good = d.lastInvolvementOk && d.lastInvolvementFocused;
      const bits = [
        d.lastInvolvementOk ? 'ответ ' + d.lastInvolvementStatus
                            : 'ОШИБКА ' + (d.lastInvolvementStatus || 'нет связи'),
        d.lastInvolvementFocused ? 'isFocused=true' : 'БЕЗ isFocused=true',
        d.lastInvolvementMs ? d.lastInvolvementMs + ' мс' : null,
        `ok ${d.pingOk | 0} / fail ${d.pingFail | 0}`
      ].filter(Boolean);
      return { text: bits.join(' · '), cls: good ? 'good' : 'bad' };
    }
    case 'fireNext': {
      if (!d.nextFireAt) return { text: 'огонёк выключен' };
      const left = Math.round((d.nextFireAt - Date.now()) / 1000);
      if (left <= 0) return { text: 'ждёт кнопку на странице' };
      return { text: left < 90 ? `следующий через ${left} с`
                               : `следующий через ${Math.round(left / 60)} мин` };
    }
    case 'rulesLine': {
      const rv = d.rules ? 'v' + d.rules.rulesVersion : '—';
      const live = d.remoteAliveAt && Date.now() - d.remoteAliveAt < 60000;
      const bits = ['правила ' + rv + (d.rulesSource === 'bundled' ? ' (встроенные)' : '')];
      if (d.ui && d.ui.uiVersion) bits.push('интерфейс v' + d.ui.uiVersion);
      if (live) bits.push('скрипт v' + (d.remoteVersion || '?') + ' работает');
      else if (d.remoteState) bits.push('скрипт: ' + d.remoteState);
      if (d.rulesError) bits.push('ошибка: ' + d.rulesError);
      if (d.updateAvailable) bits.push('есть версия ' + d.updateAvailable);
      return { text: bits.join(' · '), cls: d.rulesError ? 'bad' : live ? 'good' : '' };
    }
    default: return { text: '' };
  }
}

function toTab(message, after) {
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    if (!tab) return;
    chrome.tabs.sendMessage(tab.id, message, () => {
      void chrome.runtime.lastError;
      if (after) setTimeout(after, 300);
    });
  });
}

function runAction(name) {
  switch (name) {
    case 'confirm-now': toTab({ type: 'click-now', source: 'popup' }, refresh); break;
    case 'fire-now':    toTab({ type: 'fire-now' }, refresh); break;
    case 'test-sound':  chrome.runtime.sendMessage({ type: 'test-sound' }, () => void chrome.runtime.lastError); break;
    case 'clear-log':   chrome.storage.local.set({ log: [] }, refresh); break;
    case 'sync-rules':
      chrome.runtime.sendMessage({ type: 'sync-rules' }, () => {
        void chrome.runtime.lastError;
        setTimeout(refresh, 500);
      });
      break;
  }
}

const binders = [];   // перерисовываем только текст, не пересобирая DOM

function build(node, parent) {
  switch (node.type) {
    case 'modes': {
      const box = el('section', 'modes');
      for (const opt of node.options || []) {
        const label = el('label', 'mode');
        const input = el('input');
        input.type = 'radio'; input.name = node.key; input.value = opt.value;
        input.checked = cfg[node.key] === opt.value;
        input.addEventListener('change', () => input.checked && save({ [node.key]: opt.value }));
        const span = el('span');
        span.append(el('b', null, opt.title));
        if (opt.hint) span.append(el('em', null, opt.hint));
        label.append(input, span);
        box.append(label);
      }
      parent.append(box);
      break;
    }

    case 'button': {
      const b = el('button', node.style === 'primary' ? 'primary' : 'link', node.label);
      b.addEventListener('click', (e) => { e.preventDefault(); runAction(node.action); });
      if (node.enableWhen === 'modalOpen') binders.push(() => { b.disabled = !tabState.modalOpen; });
      parent.append(b);
      break;
    }

    case 'stats': {
      const box = el('section', 'stats');
      for (const it of node.items || []) {
        const row = el('div');
        row.append(el('span', null, it.label));
        const v = el('b');
        row.append(v);
        binders.push(() => {
          const s = sources(it.source);
          v.textContent = s.text;
          v.className = s.cls || '';
        });
        box.append(row);
      }
      parent.append(box);
      break;
    }

    case 'text': {
      const d = el('div', 'detail');
      binders.push(() => {
        const s = sources(node.source);
        d.textContent = s.text;
        d.className = 'detail ' + (s.cls || '');
      });
      parent.append(d);
      break;
    }

    case 'group': {
      const box = el('section', 'opts');
      if (node.title) box.append(el('div', 'grouptitle', node.title));
      for (const it of node.items || []) build(it, box);
      parent.append(box);
      break;
    }

    case 'toggle': {
      const label = el('label');
      const input = el('input');
      input.type = 'checkbox';
      input.checked = !!cfg[node.key];
      input.addEventListener('change', () => save({ [node.key]: input.checked }));
      label.append(input, document.createTextNode(' ' + node.label));
      parent.append(label);
      break;
    }

    case 'number': {
      const label = el('label', 'row');
      label.append(document.createTextNode(node.label));
      const input = el('input');
      input.type = 'number';
      input.min = node.min; input.max = node.max; input.step = node.step;
      input.value = cfg[node.key];
      input.addEventListener('change', () => {
        const v = Math.min(node.max, Math.max(node.min, +input.value || node.min));
        input.value = v;
        save({ [node.key]: v });
      });
      label.append(input);
      parent.append(label);
      break;
    }

    case 'pair': {
      const scale = node.scale || 1;
      const label = el('label', 'row');
      label.append(document.createTextNode(node.label));
      const lo = el('input'), hi = el('input');
      for (const i of [lo, hi]) {
        i.type = 'number'; i.min = node.min; i.max = node.max; i.step = node.step;
      }
      lo.value = cfg[node.keys[0]] / scale;
      hi.value = cfg[node.keys[1]] / scale;
      const commit = () => {
        let a = Math.max(node.min, +lo.value || node.min);
        let b = Math.max(node.min, +hi.value || node.min);
        if (b < a) b = a;
        lo.value = a; hi.value = b;
        save({ [node.keys[0]]: a * scale, [node.keys[1]]: b * scale });
      };
      lo.addEventListener('change', commit);
      hi.addEventListener('change', commit);
      label.append(lo, document.createTextNode('–'), hi);
      if (node.action) {
        const btn = el('button', 'link', node.actionLabel || 'ок');
        btn.addEventListener('click', (e) => { e.preventDefault(); runAction(node.action); });
        label.append(btn);
      }
      parent.append(label);
      break;
    }

    case 'range': {
      const label = el('label', 'row');
      label.append(document.createTextNode(node.label));
      const input = el('input');
      input.type = 'range';
      input.min = node.min; input.max = node.max; input.step = node.step;
      input.value = cfg[node.key];
      input.addEventListener('change', () => save({ [node.key]: +input.value }));
      label.append(input);
      if (node.action) {
        const btn = el('button', 'link', node.actionLabel || 'проверить');
        btn.addEventListener('click', (e) => { e.preventDefault(); runAction(node.action); });
        label.append(btn);
      }
      parent.append(label);
      break;
    }

    case 'sync': {
      const box = el('section', 'sync');
      const line = el('div', 'detail');
      binders.push(() => {
        const s = sources(node.source);
        line.textContent = s.text;
        line.className = 'detail ' + (s.cls || '');
      });
      const btn = el('button', 'link', node.actionLabel || 'обновить');
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        line.textContent = 'обновляю…';
        runAction(node.action);
      });
      box.append(line, btn);
      parent.append(box);
      break;
    }

    case 'log': {
      const box = el('section', 'logwrap');
      const head = el('div', 'loghead');
      head.append(el('span', null, node.title || 'Журнал'));
      if (node.action) {
        const btn = el('button', 'link', node.actionLabel || 'очистить');
        btn.addEventListener('click', (e) => { e.preventDefault(); runAction(node.action); });
        head.append(btn);
      }
      const ul = el('ul');
      ul.id = 'log';
      binders.push(() => {
        ul.textContent = '';
        for (const e of local.log || []) {
          const li = el('li', e.kind);
          li.append(el('time', null, hhmmss(e.t)), el('span', null, e.text));
          ul.append(li);
        }
        if (!(local.log || []).length) {
          const li = el('li', null, 'пока пусто');
          li.style.color = 'var(--muted)';
          ul.append(li);
        }
      });
      box.append(head, ul);
      parent.append(box);
      break;
    }
  }
}

function render() {
  const root = document.getElementById('root');
  root.textContent = '';
  binders.length = 0;
  for (const s of (schema && schema.sections) || []) build(s, root);
  paint();
}

function paint() {
  for (const b of binders) {
    try { b(); } catch (_) {}
  }
  const pill = document.getElementById('state');
  if (!tabState.ok)            { pill.textContent = tabState.note || 'не вебинар'; pill.className = 'pill'; }
  else if (tabState.modalOpen) { pill.textContent = 'модалка' + (tabState.timer ? ' · ' + tabState.timer : ''); pill.className = 'pill alert'; }
  else                         { pill.textContent = 'слежу'; pill.className = 'pill on'; }
}

function refresh() {
  chrome.storage.local.get(LOCAL_KEYS, (d) => {
    local = d;
    if (d.ui && d.ui.uiVersion && (!schema || d.ui.uiVersion !== schema.uiVersion)) {
      schema = d.ui;
      render();
    } else {
      paint();
    }
  });

  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    if (!tab || !/mts-link\.(ru|com)|webinar\.ru/.test(tab.url || '')) {
      tabState = { ok: false, note: 'не вебинар', modalOpen: false };
      return paint();
    }
    chrome.tabs.sendMessage(tab.id, { type: 'probe' }, (res) => {
      tabState = (chrome.runtime.lastError || !res)
        ? { ok: false, note: 'обнови вкладку', modalOpen: false }
        : { ok: true, modalOpen: res.modalOpen, timer: res.timer };
      paint();
    });
  });
}

async function boot() {
  cfg = await new Promise((r) => chrome.storage.sync.get(DEFAULTS, r));
  const stored = await new Promise((r) => chrome.storage.local.get({ ui: null }, r));
  schema = stored.ui;
  if (!schema) {
    try { schema = await (await fetch(chrome.runtime.getURL('ui.json'))).json(); }
    catch (_) { schema = { uiVersion: 0, sections: [] }; }
  }
  render();
  refresh();
  setInterval(refresh, 2000);
}

boot();
