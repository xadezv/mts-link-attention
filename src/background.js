const ICON = chrome.runtime.getURL('icons/icon-128.png');
const LOG_LIMIT = 60;
const HOSTS = ['*://*.mts-link.ru/*', '*://*.mts-link.com/*', '*://*.webinar.ru/*'];
const STALE_MIN = 5;

const now = () => Date.now();

async function pushLog(entry) {
  const { log = [] } = await chrome.storage.local.get({ log: [] });
  log.unshift(entry);
  await chrome.storage.local.set({ log: log.slice(0, LOG_LIMIT) });
}

async function badge(text, color) {
  try {
    await chrome.action.setBadgeText({ text: String(text) });
    if (color) await chrome.action.setBadgeBackgroundColor({ color });
  } catch (_) {}
}

let offscreenReady = null;
async function ensureOffscreen() {
  if (!chrome.offscreen) return false;
  if (offscreenReady) return offscreenReady;
  offscreenReady = (async () => {
    try {
      if (chrome.runtime.getContexts) {
        const ctxs = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
        if (ctxs && ctxs.length) return true;
      }
      await chrome.offscreen.createDocument({
        url: 'src/offscreen.html',
        reasons: ['AUDIO_PLAYBACK'],
        justification: 'звуковой сигнал о контроле присутствия'
      });
      return true;
    } catch (e) {

      return /single offscreen|already/i.test(String(e));
    }
  })();
  return offscreenReady;
}

async function playSound(pattern) {
  const { sound = true, soundVolume = 0.35 } = await chrome.storage.sync.get({ sound: true, soundVolume: 0.35 });
  if (!sound) return;
  const ok = await ensureOffscreen();
  if (ok) {
    try {
      chrome.runtime.sendMessage({ target: 'offscreen', type: 'play', pattern, volume: soundVolume },
        () => void chrome.runtime.lastError);
      return;
    } catch (_) {}
  }

  const { activeTabId } = await chrome.storage.local.get({ activeTabId: null });
  if (activeTabId != null) {
    chrome.tabs.sendMessage(activeTabId, { type: 'beep', pattern }, () => void chrome.runtime.lastError);
  }
}

async function notify(id, title, message, buttons) {
  const { desktopNotify = true } = await chrome.storage.sync.get({ desktopNotify: true });
  if (!desktopNotify) return;
  const opts = {
    type: 'basic', iconUrl: ICON, title, message, priority: 2,
    requireInteraction: !!(buttons && buttons.length)
  };
  if (buttons) opts.buttons = buttons;
  try { chrome.notifications.create(id, opts); } catch (_) {}
}

let activeTabId = null;

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (!msg || msg.target === 'offscreen') return;
  (async () => {
    const tabId = sender.tab && sender.tab.id;
    const t = now();

    switch (msg.type) {
      case 'modal': {
        activeTabId = tabId ?? activeTabId;
        const sh = await chrome.storage.local.get({ shows: 0 });
        await chrome.storage.local.set({
          shows: (sh.shows | 0) + 1, lastModalAt: t, modalOpen: true, activeTabId
        });
        await badge('!', '#d23b3b');
        const left = msg.payload && msg.payload.timer ? ` Осталось ${msg.payload.timer}.` : '';
        const auto = msg.payload && msg.payload.mode === 'auto';
        await pushLog({ t, kind: 'modal', text: 'появился контроль присутствия' + left });
        await playSound(auto ? 'alert' : 'siren');
        await notify(
          'attn-modal',
          auto ? 'Контроль присутствия' : '⚠ Нужно нажать «Подтверждаю»',
          auto ? `Подтверждаю автоматически.${left}` : `Открой вкладку и нажми кнопку.${left}`,
          auto ? undefined : [{ title: 'Подтвердить' }, { title: 'Открыть вкладку' }]
        );
        break;
      }

      case 'modal-remind': {
        const left = msg.payload && msg.payload.timer ? ` Осталось ${msg.payload.timer}.` : '';
        await playSound('siren');
        await notify('attn-modal', '⚠ Контроль присутствия ещё висит',
          `Кнопка «Подтверждаю» до сих пор не нажата.${left}`,
          [{ title: 'Подтвердить' }, { title: 'Открыть вкладку' }]);
        break;
      }

      case 'clicked': {
        const cur = await chrome.storage.local.get({ clicked: 0 });
        const n = (cur.clicked | 0) + 1;
        await chrome.storage.local.set({ clicked: n, lastClickAt: t, modalOpen: false });
        await badge(n, '#1c8a4a');
        await pushLog({ t, kind: 'click', text: `подтверждено (${(msg.payload && msg.payload.source) || 'auto'})` });
        try { chrome.notifications.clear('attn-modal'); } catch (_) {}
        await playSound('ok');
        await notify('attn-ok', 'Присутствие подтверждено ✔', `Всего подтверждений: ${n}`);
        break;
      }

      case 'fire': {
        const f = await chrome.storage.local.get({ fires: 0 });
        const n = (f.fires | 0) + 1;
        await chrome.storage.local.set({ fires: n, lastFireAt: t });
        await pushLog({ t, kind: 'ok', text: `нажат «Огонёк» (${n})` });
        break;
      }

      case 'success':
        await chrome.storage.local.set({ modalOpen: false });
        await pushLog({ t, kind: 'ok', text: 'платформа показала экран успеха' });
        break;

      case 'involvement': {
        const p = msg.payload || {};
        const st = await chrome.storage.local.get({ pingOk: 0, pingFail: 0, pingFailStreak: 0 });
        const good = !!p.ok && !!p.focusedTrue;
        const patch = {
          lastInvolvementAt: t,
          lastInvolvementOk: !!p.ok,
          lastInvolvementStatus: p.status || 0,
          lastInvolvementFocused: !!p.focusedTrue,
          lastInvolvementBody: p.sentBody || '',
          lastInvolvementMs: p.ms || 0,
          involvementForced: !!p.forced,
          activeTabId: tabId ?? activeTabId
        };
        if (tabId != null) activeTabId = tabId;

        if (good) {
          patch.pingOk = (st.pingOk | 0) + 1;
          patch.pingFailStreak = 0;
          if (!(st.pingOk | 0)) {
            await pushLog({ t, kind: 'ok',
              text: `пинг присутствия доехал: ${p.status} · ${p.sentBody || '—'}` });
          }
        } else {
          patch.pingFail = (st.pingFail | 0) + 1;
          patch.pingFailStreak = (st.pingFailStreak | 0) + 1;
          const why = !p.ok
            ? `ответ ${p.status || 'нет связи'}${p.error ? ' · ' + p.error : ''}`
            : 'в теле нет isFocused=true';
          await pushLog({ t, kind: 'fail', text: `пинг присутствия не засчитан: ${why}` });

          if (patch.pingFailStreak === 3) {
            await badge('!', '#d23b3b');
            await playSound('siren');
            await notify('attn-ping', '⚠ Присутствие не отправляется',
              `Три пинга подряд не прошли (${why}). Открой вкладку и проверь.`,
              [{ title: 'Открыть вкладку' }]);
          }
        }
        await chrome.storage.local.set(patch);
        break;
      }

      case 'remote-alive':
        await chrome.storage.local.set({
          remoteAliveAt: t, remoteRunning: true,
          remoteScriptVersion: (msg.payload && msg.payload.version) || null
        });
        respond && respond({ ok: true });
        return;

      case 'get-cfg': {
        const [sync, local] = await Promise.all([
          chrome.storage.sync.get({ mode: 'auto', delayMin: 1500, delayMax: 5000, repeatAlertSec: 15 }),
          chrome.storage.local.get({ rules: null })
        ]);
        respond && respond({ cfg: sync, rules: local.rules });
        return;
      }

      case 'page-load': {
        const g = await chrome.storage.local.get({ lastPageSync: 0 });
        if (t - (g.lastPageSync || 0) > 30000) {
          await chrome.storage.local.set({ lastPageSync: t });
          await syncRules(false);
        }
        respond && respond({ ok: true });
        return;
      }

      case 'set-cfg':
        if (msg.payload && typeof msg.payload === 'object') {
          await chrome.storage.sync.set(msg.payload);
        }
        respond && respond({ ok: true });
        return;

      case 'get-stats': {
        const d = await chrome.storage.local.get({
          clicked: 0, shows: 0, fires: 0, nextFireAt: 0, lastClickAt: 0,
          lastInvolvementAt: 0, lastInvolvementOk: false, lastInvolvementStatus: 0,
          lastInvolvementFocused: false, pingOk: 0, pingFail: 0,
          rules: null, remoteVersion: null, log: []
        });
        d.log = (d.log || []).slice(0, 6);
        respond && respond(d);
        return;
      }

      case 'test-sound':
        await playSound('alert');
        break;

      case 'sync-rules': {
        const r = await syncRules(true);
        const st = await chrome.storage.local.get({ remoteState: null, remoteVersion: null });
        respond && respond(Object.assign(r, st));
        return;
      }

      case 'confirm-request': {
        const p = msg.payload || {};
        await pushLog({ t, kind: p.ok ? 'ok' : 'fail',
          text: `запрос подтверждения → ${p.ok ? 'принят' : 'ОТКЛОНЁН'} (${p.status || 'нет связи'})` });
        break;
      }
    }
    respond && respond({ ok: true });
  })();
  return true;
});

const RULES_URL = 'https://raw.githubusercontent.com/xadezv/mts-link-attention/main/rules.json';
const UI_URL = 'https://raw.githubusercontent.com/xadezv/mts-link-attention/main/ui.json';
const RULES_EVERY_MIN = 180;

function validRules(r) {
  return !!r && typeof r === 'object'
    && Number.isFinite(r.rulesVersion)
    && Array.isArray(r.modalSelectors) && r.modalSelectors.length > 0
    && Array.isArray(r.confirmButtonTexts) && r.confirmButtonTexts.length > 0
    && typeof r.involvementRe === 'string';
}

function validUi(u) {
  return !!u && typeof u === 'object'
    && Number.isFinite(u.uiVersion)
    && Array.isArray(u.sections) && u.sections.length > 0;
}

async function syncUi() {
  try {
    const res = await fetch(UI_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const u = await res.json();
    if (!validUi(u)) throw new Error('интерфейс не прошёл проверку');
    const cur = await chrome.storage.local.get({ ui: null });
    await chrome.storage.local.set({ ui: u });
    if (!cur.ui || cur.ui.uiVersion !== u.uiVersion) {
      await pushLog({ t: now(), kind: 'ok', text: 'интерфейс обновлён до v' + u.uiVersion });
    }
  } catch (_) {
    const cur = await chrome.storage.local.get({ ui: null });
    if (!cur.ui) {
      const b = await loadBundledUi();
      if (b) await chrome.storage.local.set({ ui: b });
    }
  }
}

async function loadBundledUi() {
  try {
    const res = await fetch(chrome.runtime.getURL('ui.json'));
    const u = await res.json();
    return validUi(u) ? u : null;
  } catch (_) { return null; }
}

async function loadBundledRules() {

  try {
    const res = await fetch(chrome.runtime.getURL('rules.json'));
    const r = await res.json();
    return validRules(r) ? r : null;
  } catch (_) { return null; }
}

async function syncRules(manual) {
  const t = now();
  let fetched = null, error = null;
  try {
    const res = await fetch(RULES_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const r = await res.json();
    if (!validRules(r)) throw new Error('правила не прошли проверку');
    fetched = r;
  } catch (e) {
    error = String(e).slice(0, 160);
  }

  const cur = await chrome.storage.local.get({ rules: null, updateNotifiedAt: 0 });

  if (!fetched) {
    await chrome.storage.local.set({ rulesError: error, rulesCheckedAt: t });
    if (!cur.rules) {
      const bundled = await loadBundledRules();
      if (bundled) await chrome.storage.local.set({ rules: bundled, rulesSource: 'bundled' });
    }
    if (manual) await pushLog({ t, kind: 'fail', text: 'правила не обновились: ' + error });
    return { ok: false, error };
  }

  const prevV = cur.rules && cur.rules.rulesVersion;
  await chrome.storage.local.set({
    rules: fetched, rulesSource: 'remote', rulesCheckedAt: t, rulesError: null
  });
  if (prevV !== fetched.rulesVersion) {
    await pushLog({ t, kind: 'ok',
      text: `правила обновлены до v${fetched.rulesVersion}${fetched.notes ? ' — ' + fetched.notes : ''}` });
  } else if (manual) {
    await pushLog({ t, kind: 'ok', text: `правила актуальны (v${fetched.rulesVersion})` });
  }

  const mine = chrome.runtime.getManifest().version;
  if (fetched.extensionVersion && cmpVer(fetched.extensionVersion, mine) > 0
      && now() - (cur.updateNotifiedAt || 0) > 24 * 3600e3) {
    await chrome.storage.local.set({ updateNotifiedAt: now(), updateAvailable: fetched.extensionVersion });
    await notify('attn-update', 'Вышла новая версия расширения',
      `У тебя ${mine}, в репозитории ${fetched.extensionVersion}. Скачать и переставить папку?`,
      [{ title: 'Скачать' }]);
  } else if (!fetched.extensionVersion || cmpVer(fetched.extensionVersion, mine) <= 0) {
    await chrome.storage.local.set({ updateAvailable: null });
  }
  await syncUserScript(fetched, manual);
  await syncUi();
  return { ok: true, rulesVersion: fetched.rulesVersion };
}

function cmpVer(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

chrome.alarms.create('attn-rules', { periodInMinutes: RULES_EVERY_MIN, when: Date.now() + 5000 });
chrome.runtime.onStartup.addListener(() => syncRules(false));

const US_ID = 'attn-remote';
const US_MAIN_ID = 'attn-remote-main';

function userScriptsAvailable() {
  try { return !!(chrome.userScripts && chrome.userScripts.register); }
  catch (_) { return false; }
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function syncUserScript(rules, manual) {
  await registerRemote(rules && rules.remoteScript, US_ID, 'USER_SCRIPT', 'remote', manual);
  await registerRemote(rules && rules.remoteMainScript, US_MAIN_ID, 'MAIN', 'remoteMain', manual);
}

async function registerRemote(spec, id, world, prefix, manual) {
  if (!userScriptsAvailable()) {
    await chrome.storage.local.set({ [prefix + 'State']: 'нет доступа: включи «Разрешить пользовательские скрипты»' });
    return;
  }
  if (!spec || !spec.enabled || !spec.url) {
    try { await chrome.userScripts.unregister({ ids: [id] }); } catch (_) {}
    await chrome.storage.local.set({ [prefix + 'State']: 'выключен в правилах', [prefix + 'Version']: null });
    return;
  }

  const prev = await chrome.storage.local.get({ [prefix + 'Version']: null, [prefix + 'Code']: null });
  let code = prev[prefix + 'Code'];

  if (prev[prefix + 'Version'] !== spec.version || !code) {
    try {
      const res = await fetch(spec.url, { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const text = await res.text();

      if (spec.sha256) {
        const got = await sha256Hex(text);
        if (got !== spec.sha256) throw new Error('sha256 не совпал');
      }
      code = text;
      await chrome.storage.local.set({ [prefix + 'Code']: code, [prefix + 'Version']: spec.version });
      await pushLog({ t: now(), kind: 'ok',
        text: `удалённый скрипт (${world}) обновлён до v${spec.version}` });
    } catch (e) {
      await chrome.storage.local.set({ [prefix + 'State']: 'ошибка загрузки: ' + String(e).slice(0, 80) });
      if (manual) await pushLog({ t: now(), kind: 'fail', text: 'удалённый скрипт не загрузился: ' + e });
      if (!code) return;
    }
  }

  const script = {
    id,
    matches: spec.matches || ['*://*.mts-link.ru/*', '*://*.mts-link.com/*', '*://*.webinar.ru/*'],
    js: [{ code }],
    runAt: world === 'MAIN' ? 'document_start' : 'document_idle',
    world,
    allFrames: true
  };

  try {
    await chrome.userScripts.configureWorld({ messaging: true });
    const existing = await chrome.userScripts.getScripts({ ids: [id] });
    if (existing && existing.length) await chrome.userScripts.update([script]);
    else await chrome.userScripts.register([script]);
    await chrome.storage.local.set({ [prefix + 'State']: 'зарегистрирован', [prefix + 'Version']: spec.version });
  } catch (e) {
    await chrome.storage.local.set({ [prefix + 'State']: 'не зарегистрирован: ' + String(e).slice(0, 80) });
  }
}

chrome.alarms.create('attn-stale', { periodInMinutes: 2 });

chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name === 'attn-rules') return void syncRules(false);
  if (a.name !== 'attn-stale') return;
  let tabs = [];
  try { tabs = await chrome.tabs.query({ url: HOSTS }); } catch (_) {}
  if (!tabs.length) return;

  const d = await chrome.storage.local.get({ lastInvolvementAt: 0, staleNotifiedAt: 0 });
  if (!d.lastInvolvementAt) return;
  const mins = (now() - d.lastInvolvementAt) / 60000;
  if (mins < STALE_MIN) return;
  if (now() - d.staleNotifiedAt < 15 * 60000) return;

  await chrome.storage.local.set({ staleNotifiedAt: now() });
  await pushLog({ t: now(), kind: 'fail', text: `пингов нет ${Math.round(mins)} мин` });
  await playSound('siren');
  await notify('attn-ping', '⚠ Присутствие не подтверждается',
    `Вкладка вебинара открыта, но пинг не уходил ${Math.round(mins)} мин. Перезагрузи страницу.`,
    [{ title: 'Открыть вкладку' }]);
});

function sendClick(tabId) {
  if (tabId == null) return;
  chrome.tabs.sendMessage(tabId, { type: 'click-now', source: 'notification' },
    () => void chrome.runtime.lastError);
}

async function focusTab(tabId) {
  if (tabId == null) return;
  try {
    const tab = await chrome.tabs.update(tabId, { active: true });
    if (tab && tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true });
  } catch (_) {}
}

chrome.notifications.onButtonClicked.addListener(async (id, idx) => {
  if (id === 'attn-update') {
    const { rules } = await chrome.storage.local.get({ rules: null });
    const url = (rules && rules.downloadUrl)
      || 'https://github.com/xadezv/mts-link-attention/releases/latest';
    try { await chrome.tabs.create({ url }); } catch (_) {}
    try { chrome.notifications.clear(id); } catch (_) {}
    return;
  }
  const { activeTabId: stored } = await chrome.storage.local.get({ activeTabId: null });
  const tabId = activeTabId ?? stored;
  if (id === 'attn-modal' && idx === 0) sendClick(tabId);
  else await focusTab(tabId);
  try { chrome.notifications.clear(id); } catch (_) {}
});

chrome.notifications.onClicked.addListener(async (id) => {
  const { activeTabId: stored } = await chrome.storage.local.get({ activeTabId: null });
  await focusTab(activeTabId ?? stored);
  try { chrome.notifications.clear(id); } catch (_) {}
});

chrome.runtime.onInstalled.addListener(async () => {
  const { clicked = 0 } = await chrome.storage.local.get({ clicked: 0 });
  await badge(clicked || '', '#1c8a4a');
  await pushLog({ t: now(), kind: 'ok', text: 'расширение установлено/обновлено' });
  const bundled = await loadBundledRules();
  if (bundled) await chrome.storage.local.set({ rules: bundled, rulesSource: 'bundled' });
  const bundledUi = await loadBundledUi();
  if (bundledUi) await chrome.storage.local.set({ ui: bundledUi });
  await syncRules(false);
});
