/* language: JavaScript (ES2022) | file: public/app.js | runtime: Safari 16+ / iOS PWA
   UI controller. profile building goes through the server when reachable and falls back to the
   shared pure builder so the app still works offline or when the service is down. */

import { buildProfile as buildLocal, normalizeOptions, formatForIos, referenceOptions, simpleOptions } from '/shared/profile.js?v=__BUILD__';
import { OPERATORS, FORMATS, IOS_MATRIX, verificationOf } from '/shared/catalog.js?v=__BUILD__';

const STORE_KEY = 'ir.history.v1';
const THEME_KEY = 'ir.theme';
const DROP_KEY = 'ir.events.v1';
const GUARD_KEY = 'ir.guard.v1';
const GUARD_REFRESH_MS = 3 * 60 * 60 * 1000;

const state = {
  tab: 'build',
  operatorId: 'mci',
  format: 'universal',
  protocol: 'both',
  auth: 'PAP',
  preset: 'simple',
  omitCredentials: true,
  xlat: false,
  attach: false,
  proxy: '',
  proxyPort: '',
  proxyUsername: '',
  proxyPassword: '',
  removalDate: '',
  webClip: false,
  displayName: 'آنتن',
  customEntries: [{ apn: '', username: '', password: '' }],
  advanced: false,
  busy: false,
  linkDown: false,
  history: loadHistory(),
  drops: loadDrops(),
  guard: false,
  ready: null,
  catalogue: null,
  lastBuild: null
};

const savedGuard = loadGuard();
state.guard = savedGuard.on;
state.ready = savedGuard.ready;

const STATIC = Boolean(window.__STATIC);

const view = document.getElementById('view');
const toastEl = document.getElementById('toast');
const sheet = document.getElementById('sheet');
const sheetTitle = document.getElementById('sheetTitle');
const sheetBody = document.getElementById('sheetBody');

/* ---------- utils ---------- */

const FA_DIGITS = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'];
const fa = (value) => String(value).replace(/\d/g, (d) => FA_DIGITS[Number(d)]);
const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function detectIosMajor() {
  const m = navigator.userAgent.match(/(?:iPhone|iPod|iPad).*?OS (\d+)_/);
  return m ? Number(m[1]) : 0;
}

function toast(message, isError = false) {
  toastEl.textContent = message;
  toastEl.classList.toggle('err', Boolean(isError));
  toastEl.classList.add('show');
  clearTimeout(toastEl._timer);
  toastEl._timer = setTimeout(() => toastEl.classList.remove('show'), 3600);
}

function loadHistory() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || '[]');
    return Array.isArray(raw) ? raw.filter((h) => h && typeof h === 'object' && typeof h.id === 'string' && Number.isFinite(h.createdAt)).slice(0, 60) : [];
  } catch {
    return [];
  }
}

function saveHistory(list) {
  state.history = list.slice(0, 60);
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state.history));
  } catch {
    /* quota, history is nice to have */
  }
}

/* ---------- test log ----------
   A field test needs numbers, not impressions. Two things are recorded locally: every reported
   drop (with the uptime it had) and the reported outcome of every install. One copyable report
   carries both, so a tester can paste it into the channel instead of describing it. */

function loadDrops() {
  try {
    const raw = JSON.parse(localStorage.getItem(DROP_KEY) || '[]');
    return Array.isArray(raw) ? raw.filter((d) => d && ['up', 'fail', 'drop'].includes(d.kind) && Number.isFinite(d.at)).slice(0, 120) : [];
  } catch {
    return [];
  }
}

function saveDrops(list) {
  state.drops = list.slice(0, 120);
  try {
    localStorage.setItem(DROP_KEY, JSON.stringify(state.drops));
  } catch {
    /* quota */
  }
}

function recordDrop(operatorId, profileId) {
  const last = state.history.find((h) => h.id === profileId) || state.history.find((h) => h.operatorId === operatorId) || state.history[0];
  if (!last) return;
  const success = state.drops.find((d) => d.profileId === last.id && d.kind === 'up');
  if (state.drops.some((d) => d.profileId === last.id && d.kind === 'drop')) return;
  const uptime = success ? Math.max(0, Date.now() - success.at) : null;
  saveDrops([
    { kind: 'drop', at: Date.now(), profileId: last.id, operatorId: last.operatorId, uptime, ua: navigator.userAgent },
    ...state.drops
  ]);
}

/** the tester's answer right after installing: did the antenna come back or not */
function recordOutcome(kind) {
  const last = state.history.find((h) => h.id === state.activeProfileId) || state.history[0];
  if (!last) return;
  if (!['up', 'fail'].includes(kind)) return;
  // One answer per profile; corrections replace the answer instead of inflating totals.
  const previous = state.drops.find((d) => d.profileId === last.id && d.kind === kind);
  if (previous) return;
  saveDrops([
    {
      kind,
      profileId: last.id,
      entries: last.entries,
      settings: last.settings ? { protocol: last.settings.protocol, auth: last.settings.auth,
        attach: last.settings.attach, xlat: last.settings.xlat } : undefined,
      at: Date.now(),
      operatorId: last.operatorId,
      format: last.format,
      ua: navigator.userAgent
    },
    ...state.drops.filter((d) => d.profileId !== last.id || !['up', 'fail'].includes(d.kind))
  ]);
}

function dropStats() {
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const today = state.drops.filter((d) => d.kind === 'drop' && d.at >= dayAgo);
  const last = state.drops.find((d) => d.kind === 'drop');
  const timed = today.filter((d) => d.profileId && Number.isFinite(d.uptime));
  const avg = timed.length ? Math.round(timed.reduce((s, d) => s + d.uptime, 0) / timed.length) : 0;
  const ups = state.drops.filter((d) => d.kind === 'up' && d.at >= dayAgo).length;
  const fails = state.drops.filter((d) => d.kind === 'fail' && d.at >= dayAgo).length;
  return { today: today.length, last, avg, ups, fails };
}

function durationLabel(ms) {
  const mins = Math.max(0, Math.round(ms / 60_000));
  if (mins < 60) return `${fa(mins)} دقیقه`;
  const hours = Math.floor(mins / 60);
  const rest = mins % 60;
  if (hours < 24) return rest ? `${fa(hours)} ساعت و ${fa(rest)} دقیقه` : `${fa(hours)} ساعت`;
  return `${fa(Math.round(hours / 24))} روز`;
}

function testReport() {
  const { today, last, avg, ups, fails } = dropStats();
  const ios = (navigator.userAgent.match(/OS (\d+[_.]\d+(?:[_.]\d+)?)/) || [])[1]?.replace(/_/g, '.') || 'نامشخص';
  const op = state.history[0]?.operatorId || 'نامشخص';
  const apnList = (state.history[0]?.entries || []).join(' , ');
  const settings = state.history[0]?.settings;
  return [
    'گزارش تست آنتن',
    `اپراتور: ${op}`,
    `APN: ${apnList || 'نامشخص'}`,
    `iOS: ${ios}`,
    `قالب: ${state.history[0]?.format || 'نامشخص'}`,
    `پروتکل: ${settings?.protocol || 'نامشخص'} · احراز هویت: ${settings?.auth === 'NONE' ? 'پیش‌فرض سیستم (PAP)' : (settings?.auth || 'پیش‌فرض اپراتور')}`,
    `AttachAPN: ${settings ? (settings.attach ? 'روشن' : 'خاموش') : 'نامشخص'} · 464XLAT: ${settings ? (settings.xlat && state.history[0]?.format !== 'legacy' ? 'روشن' : 'خاموش') : 'نامشخص'}`,
    `نشانه: ${state.history[0]?.symptom || 'ثبت نشده'}`,
    `مدل اعلام‌شده: ${state.history[0]?.deviceModel || state.deviceModel || 'نامشخص'}`,
    last?.profileId && Number.isFinite(last.uptime) ? `فاصله از گزارش بازگشت تا افتادن: ${durationLabel(last.uptime)}` : 'مدت اتصال اندازه‌گیری نشده',
    'آمار زیر مجموع همهٔ آزمایش‌ها در همین مرورگر است:',
    `افتادن در ۲۴ ساعت: ${fa(today)}`,
    `گزارش بازگشت آنتن در ۲۴ ساعت: ${fa(ups)}`,
    `نصب بی‌نتیجه در ۲۴ ساعت: ${fa(fails)}`,
    avg ? `میانگین مدت اتصال گزارش‌شده: ${durationLabel(avg)}` : null,
    'نتایج دستی هستند؛ وب‌سایت به وضعیت مودم دسترسی ندارد. گزارش شامل رمز APN یا پروکسی نیست.',
    `گوشی: ${navigator.userAgent.includes('iPhone') ? 'iPhone' : 'سایر'}`
  ]
    .filter(Boolean)
    .join('\n');
}

/* ---------- guard mode ----------
   Fully automatic path: while guard is on, a fresh profile is minted ahead of time and kept in
   hand, so the user only confirms the install prompt instead of waiting for a build. */

function loadGuard() {
  try {
    const raw = JSON.parse(localStorage.getItem(GUARD_KEY) || '{}');
    const ready = raw.ready;
    return { on: raw.on === true, ready: ready && (ready.xml || /^https?:/.test(ready.url || '')) ? ready : null };
  } catch {
    return { on: false, ready: null };
  }
}

function saveGuard() {
  try {
    localStorage.setItem(GUARD_KEY, JSON.stringify({ on: state.guard, ready: state.ready }));
  } catch {
    /* quota */
  }
}

function readyAge() {
  return state.ready ? Date.now() - state.ready.at : Infinity;
}

function readyFresh() {
  return Boolean(state.ready && (state.ready.xml || state.ready.url) && readyAge() >= 0 && readyAge() < GUARD_REFRESH_MS);
}

async function primeGuard() {
  if (!state.guard || state.busy) return;
  const last = state.history[0];
  if (!last) return;
  if (readyFresh() && state.ready.operatorId === last.operatorId && JSON.stringify(state.ready.settings) === JSON.stringify(last.settings)) return;
  await handleBuild(true, last.settings || { operatorId: last.operatorId, format: last.format });
}

function restoreSettings(record) {
  if (record?.settings) Object.assign(state, record.settings);
}

function profileHistory(id, uuid, payload, entries, extra = {}) {
  // Saved only on this browser so recovery can reproduce custom APNs and credentials.
  const effective = normalizeOptions(payload);
  return { id, uuid, operatorId: payload.operatorId, format: payload.format, entries,
    createdAt: Date.now(), settings: { ...payload, auth: effective.auth }, symptom: state.symptom || '', deviceModel: state.deviceModel || '', ...extra };
}

async function api(path, options = {}) {
  // a stalled request must never freeze the primary action: abort and let the caller fall back
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch(path, {
      signal: ctrl.signal,
      ...options,
      headers: { 'content-type': 'application/json', ...(options.headers || {}) }
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const error = new Error(data.error || `خطای سرور (${res.status})`);
      error.status = res.status;
      throw error;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

function openSheet(title, html) {
  sheetTitle.textContent = title;
  sheetBody.innerHTML = html;
  sheet.hidden = false;
  document.body.style.overflow = 'hidden';
  lastFocused = document.activeElement;
  const closeBtn = sheet.querySelector('.sheet-head .icon-btn');
  if (closeBtn) closeBtn.focus();

  // replay the one-shot edge sweep: the sheet only opens when a file is actually ready
  const panel = sheet.querySelector('.sheet-panel');
  if (panel) {
    panel.classList.remove('is-fresh');
    void panel.offsetWidth;
    panel.classList.add('is-fresh');
  }
}

function closeSheet() {
  sheet.hidden = true;
  document.body.style.overflow = '';
  if (lastFocused && typeof lastFocused.focus === 'function') lastFocused.focus();
  lastFocused = null;
}

let lastFocused = null;

/* ---------- payload ---------- */

function collectPayload() {
  const payload = {
    preset: state.preset,
    omitCredentials: state.omitCredentials,
    operatorId: state.operatorId,
    format: state.format,
    protocol: state.protocol,
    auth: state.auth || undefined,
    xlat: state.xlat,
    attach: state.attach,
    displayName: state.displayName,
    webClip: state.webClip,
    webClipUrl: new URL('./', location.href).href,
    webClipLabel: 'آنتن'
  };
  if (state.proxy) payload.proxy = state.proxy;
  if (state.proxyPort) payload.proxyPort = state.proxyPort;
  if (state.proxyUsername) payload.proxyUsername = state.proxyUsername;
  if (state.proxyPassword) payload.proxyPassword = state.proxyPassword;
  if (state.removalDate) payload.removalDate = `${state.removalDate}T23:59:59Z`;
  if (state.operatorId === 'custom') {
    payload.customEntries = state.customEntries.filter((e) => e.apn.trim()).map((e) => ({ ...e }));
  }
  return payload;
}

/* ---------- keep-alive watchdog ----------
   The antenna drops on network events, so the app watches its own reachability: three failed
   pings in a row mean the link is gone, which is the moment the recovery card matters. */

let linkFails = 0;
let pingTimer = null;
let guardTimer = null;

async function pingNow() {
  if (STATIC) return;
  try {
    const res = await fetch('/api/ping', { cache: 'no-store', signal: AbortSignal.timeout(2500) });
    if (!res.ok) throw new Error(String(res.status));
    linkFails = 0;
    if (state.linkDown) {
      state.linkDown = false;
      if (state.tab === 'build') renderBuild();
    }
  } catch {
    linkFails += 1;
    if (linkFails >= 3 && !state.linkDown) {
      state.linkDown = true;
      if (state.tab === 'build') renderBuild();
      toast('اتصال قطع شد؛ اگر آنتن نیست پروفایل تازه بساز');
      // the link just died: have a fresh file waiting before the user even asks
      primeGuard();
    }
  }
}

function startWatch() {
  clearInterval(pingTimer);
  pingTimer = setInterval(pingNow, 60_000);
  // guard refresh ticks often but only builds when the held file is older than three hours
  clearInterval(guardTimer);
  guardTimer = setInterval(primeGuard, 10 * 60_000);
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    linkFails = 0;
    pingNow();
    primeGuard();
  }
});

function downloadUrl(url) {
  const a = document.createElement('a');
  a.href = url;
  // explicit download hint: without it Chrome navigates first, then turns the response into a
  // download, which can leave the next request waiting on the same connection
  a.download = '';
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function downloadBlob(text, filename) {
  const blob = new Blob([text], { type: 'application/x-apple-aspen-config;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/* ---------- build flow ---------- */

async function handleBuild(silent = false, preparedPayload = null) {
  // a second tap while a build runs should not be lost, queue exactly one follow-up
  if (state.busy) {
    state.pendingBuild = true;
    return;
  }
  state.busy = true;
  // hoisted: the catch builds locally and needs it, a try-scoped const would not be visible there
  let payload;

  try {
    payload = preparedPayload || collectPayload();
    // Prepared files survive a reload. A blob URL is valid only in its creating document.
    if (silent) {
      const built = buildLocal(payload);
      state.ready = { xml: built.xml, id: built.uuids.root, operatorId: payload.operatorId,
        entries: built.opts.entries.map((e) => e.apn), format: payload.format,
        settings: payload, at: Date.now() };
      saveGuard();
      if (state.tab === 'build') renderBuild();
      return;
    }
    const btn = document.getElementById('buildBtn');
    if (btn && !silent) {
      btn.disabled = true;
      btn.dataset.busy = 'true';
      btn.setAttribute('aria-busy', 'true');
      btn.innerHTML = 'در حال ساخت…';
    }

    const res = STATIC
      ? await Promise.reject(new Error('static build'))
      : await api('/api/profile', { method: 'POST', body: JSON.stringify(payload) });
    state.lastBuild = res;
    saveHistory([
      profileHistory(res.id, res.uuid, payload, res.entries, { url: res.downloadUrl, preview: res.previewUrl }),
      ...state.history
    ]);

    state.activeProfileId = res.id;
    downloadUrl(res.downloadUrl);
    openSheet('پروفایل ساخته شد', installSheetHtml(res.entries, res.format));
    // refresh the view underneath so the recovery card is already there when the sheet closes
    if (state.tab === 'build') renderBuild();
  } catch (err) {
    if (silent || (err.status >= 400 && err.status < 500)) {
      toast(err.message || 'تنظیمات را بررسی کنید', true);
      return;
    }
    try {
      const built = buildLocal(payload);
      const { xml, uuids } = built;
      // the APN actually baked into the file: a test report without it cannot be diagnosed
      const apns = (built.opts?.entries || []).map((e) => e.apn).filter(Boolean);
      downloadBlob(xml, `anten-${uuids.root.slice(0, 8)}.mobileconfig`);
      saveHistory([
        profileHistory(uuids.root, uuids.root, payload, apns, { local: true }),
        ...state.history
      ]);
      state.activeProfileId = uuids.root;
      renderBuild();
      openSheet('پروفایل ساخته شد', installSheetHtml(apns, payload.format));
      toast('پروفایل ساخته شد؛ در Settings نصبش کنید');
    } catch (localErr) {
      toast(localErr.message || err.message || 'ساخت پروفایل ناموفق بود', true);
    }
  } finally {
    state.busy = false;
    const again = document.getElementById('buildBtn');
    if (again) {
      again.disabled = false;
      delete again.dataset.busy;
      again.removeAttribute('aria-busy');
      again.textContent = 'ساخت پروفایل اختصاصی';
    }
    if (state.pendingBuild) {
      state.pendingBuild = false;
      setTimeout(handleBuild, 200);
    }
  }
}

function installSheetHtml(entries, format) {
  return `
    <div class="steps">
      <li><b>فایل آماده است.</b> در Safari دانلود را تأیید کنید؛ نمایش این پنجره به معنی نصب نیست.</li>
      <li><b>تنظیمات</b>: <bdi dir="ltr">General → VPN &amp; Device Management → Downloaded Profile</bdi></li>
      <li>روی پروفایل بزنید، <b>Install</b> و بعد تأیید رمز عبور دستگاه.</li>
      <li>پس از نصب، اتصال داده را بررسی کنید. در صورت نیاز یک بار حالت هواپیما را روشن و خاموش کنید.</li>
    </div>
    <div class="divider"></div>
    <p class="muted">قالب: ${esc(format)} ${entries && entries.length ? `· APN: ${esc(entries.join(' , '))}` : ''}</p>
    <p class="muted">پیش از آزمایش بعدی، پروفایل آزمایشی قبلی را از تنظیمات حذف کنید. پروفایل APN، رجیستری یا محدودیت IMEI شبکه را تغییر نمی‌دهد و بازگشت آنتن تضمین‌شده نیست.</p>
    <p class="muted">فایل محلی بدون امضا است. در صورت نمایش Unsigned، فقط اگر منبع و تنظیمات فایل را می‌شناسید نصب کنید.</p>
    <div class="divider"></div>
    <p class="muted">نتیجه چه بود؟ همین حالا ثبت کنید تا تست جمع‌بندی شود.</p>
    <div class="hist-actions" style="margin-top:8px">
      <button class="mini-btn accent" data-act="report-up" type="button">نصب کردم، آنتن آمد</button>
      <button class="mini-btn danger" data-act="report-fail" type="button">نصب کردم، نتیجه نداد</button>
    </div>
  `;
}

/* ---------- views ---------- */

function render() {
  document.querySelectorAll('.tab').forEach((t) => {
    t.setAttribute('aria-current', t.dataset.tab === state.tab ? 'page' : 'false');
  });
  view.classList.remove('has-cta');
  if (state.tab === 'build') renderBuild();
  if (state.tab === 'guide') renderGuide();
  if (state.tab === 'history') renderHistory();
  if (state.tab === 'about') renderAbout();
}

function activeApnList() {
  const activeOp = OPERATORS.find((o) => o.id === state.operatorId);
  if (state.operatorId === 'custom') return state.customEntries.map((e) => e.apn).filter(Boolean);
  if (Array.isArray(activeOp?.entries)) return activeOp.entries.map((e) => e.apn);
  return OPERATORS.flatMap((o) => (Array.isArray(o.entries) ? o.entries.map((e) => e.apn) : []));
}

function summaryHtml() {
  const activeOp = OPERATORS.find((o) => o.id === state.operatorId);
  const apnList = activeApnList();
  return `
    <div class="summary">
      <div class="sum-item"><span>اپراتور</span><b>${esc(activeOp ? activeOp.fa : 'خالی')}</b></div>
      <div class="sum-item"><span>قالب</span><b>${esc(state.format)}</b></div>
      <div class="sum-item"><span>APN</span><b>${esc(apnList.slice(0, 2).join(' , ') || 'خالی')}${apnList.length > 2 ? ` +${fa(apnList.length - 2)}` : ''}</b></div>
    </div>`;
}

function refreshSummary() {
  const node = view.querySelector('.summary');
  if (node) node.outerHTML = summaryHtml();
}

/* ---------- selects ----------
   native <select> opens an OS menu that ignores the app surface, so the three option fields use a
   listbox we draw ourselves. keyboard rules follow the ARIA combobox pattern. */

const SELECT_FIELDS = {
  format: () => FORMATS.map((f) => ({ value: f.id, label: f.fa })),
  protocol: () => [
    { value: 'both', label: 'IPv4 + IPv6' },
    { value: 'ipv4', label: 'فقط IPv4' },
    { value: 'ipv6', label: 'فقط IPv6' }
  ],
  auth: () => [
    { value: '', label: 'خودکار' },
    { value: 'PAP', label: 'PAP' },
    { value: 'CHAP', label: 'CHAP' },
    { value: 'NONE', label: 'پیش‌فرض سیستم (PAP)' }
  ]
};

function selectHtml(name, labelId) {
  const items = SELECT_FIELDS[name]();
  const current = state[name];
  const chosen = items.find((i) => i.value === current) || items[0];
  return `
    <div class="sel" data-sel="${name}">
      <button class="sel-btn" type="button" aria-haspopup="listbox" aria-expanded="false"
              aria-controls="menu-${name}" aria-labelledby="${labelId} sel-val-${name}">
        <span class="sel-val" id="sel-val-${name}">${esc(chosen.label)}</span>
        <span class="sel-arrow" aria-hidden="true"></span>
      </button>
      <ul class="sel-menu" id="menu-${name}" role="listbox" aria-labelledby="${labelId}" hidden>
        ${items
          .map(
            (i) =>
              `<li role="option" data-value="${esc(i.value)}" aria-selected="${i.value === current}" tabindex="-1">${esc(i.label)}</li>`
          )
          .join('')}
      </ul>
    </div>`;
}

function closeSelects(except) {
  view.querySelectorAll('.sel').forEach((sel) => {
    if (sel === except) return;
    const btn = sel.querySelector('.sel-btn');
    const menu = sel.querySelector('.sel-menu');
    btn.setAttribute('aria-expanded', 'false');
    menu.hidden = true;
    menu.classList.remove('sel-menu-up');
  });
}

function openSelect(sel) {
  closeSelects(sel);
  const btn = sel.querySelector('.sel-btn');
  const menu = sel.querySelector('.sel-menu');
  btn.setAttribute('aria-expanded', 'true');
  menu.hidden = false;
  const items = [...menu.querySelectorAll('[role="option"]')];
  const target = items.find((li) => li.getAttribute('aria-selected') === 'true') || items[0];
  items.forEach((li) => li.classList.remove('is-active'));
  if (target) {
    target.classList.add('is-active');
    target.focus({ preventScroll: true });
  }
  const rect = btn.getBoundingClientRect();
  const needed = Math.min(menu.scrollHeight, 260) + 14;
  menu.classList.toggle('sel-menu-up', rect.bottom + needed > window.innerHeight && rect.top > needed);
}

function commitSelect(sel, value) {
  markCustomSettings();
  const name = sel.dataset.sel;
  state[name] = value;
  const items = [...sel.querySelectorAll('[role="option"]')];
  items.forEach((li) => li.setAttribute('aria-selected', String(li.dataset.value === value)));
  const chosen = items.find((li) => li.dataset.value === value);
  sel.querySelector('.sel-val').textContent = chosen ? chosen.textContent : '';
  closeSelects();
  sel.querySelector('.sel-btn').focus({ preventScroll: true });
  refreshSummary();
}

function ageLabel(ts) {
  const mins = Math.max(0, Math.round((Date.now() - ts) / 60000));
  if (mins < 60) return mins < 2 ? 'همین حالا' : `${fa(mins)} دقیقه پیش`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${fa(hours)} ساعت پیش`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'دیروز' : `${fa(days)} روز پیش`;
}

function renderBuild() {
  view.classList.add('has-cta');

  const last = state.history[0];
  const lastOp = last ? OPERATORS.find((o) => o.id === last.operatorId) : null;
  const linkBanner = state.linkDown
    ? `<div class="linkdown" role="status">
        <b>اتصال قطع است</b>
        <span>اگر آنتن نیست، همین حالا پروفایل تازه بساز.</span>
      </div>`
    : '';
  // guard: the automatic path. Ready file in hand beats a button that has to build first.
  const ready = state.ready;
  const readyCard =
    state.guard && readyFresh()
      ? `<div class="recover ready">
          <div class="recover-main">
            <span class="recover-label">پروفایل آماده، ساخته‌شده ${ageLabel(ready.at)}</span>
            <span class="recover-meta">${esc(ready.format || 'universal')} · نگهبان خودکار روشن است</span>
          </div>
          <button class="mini-btn accent" data-act="install-ready" type="button">دانلود و نصب</button>
        </div>`
      : '';

  const guardRow = last
    ? `<div class="guard-row">
        <div>
          <b>نگهبان خودکار</b>
          <span>وقتی صفحه باز است، فایل تازه آماده می‌کند. نصب در تنظیمات دستی است. فایل و تنظیمات آن فقط در همین مرورگر ذخیره می‌شوند.</span>
        </div>
        <button class="switch" role="switch" aria-checked="${state.guard}" data-act="toggle-guard" type="button" aria-label="نگهبان خودکار"><span></span></button>
      </div>`
    : '';

  // cloud guard: a managed phone needs no taps at all, so it sits under the local guard

  const recoverHtml = last
    ? `
    <section class="block">
      ${linkBanner}
      ${readyCard}
      ${guardRow}
      <div class="recover">
        <div class="recover-main">
          <span class="recover-label">آخرین پروفایل</span>
          <span class="recover-meta">${esc(lastOp ? lastOp.fa : last.operatorId)} · ${ageLabel(last.createdAt)}</span>
        </div>
        <button class="mini-btn accent" data-act="rebuild" data-op="${esc(last.operatorId)}" type="button">آنتن پرید؟ پروفایل تازه</button>
      </div>
      <p class="hint">ساخت فایل به معنی نصب یا بازگشت آنتن نیست. برای مقایسه، پیش از نصب فایل تازه، پروفایل آزمایشی قبلی را حذف کنید.</p>
    </section>`
    : linkBanner
      ? `<section class="block">${linkBanner}</section>`
      : '';

  const cards = OPERATORS.map(
    (op) => `
      <button class="op-card" data-op="${op.id}" aria-pressed="${state.operatorId === op.id}" type="button">
        <span class="op-check" aria-hidden="true"></span>
        <span class="op-name">${esc(op.fa)}</span>
        <span class="op-en">${esc(op.en)}</span>
      </button>`
  ).join('');

  const customBlock =
    state.operatorId === 'custom'
      ? `
      <div class="block">
        <h2 class="block-title">APN سفارشی</h2>
        ${state.customEntries
          .map(
            (e, i) => `
          <div class="apn-row" data-row="${i}">
            <input data-custom="apn" data-i="${i}" value="${esc(e.apn)}" placeholder="apn" dir="ltr" inputmode="latin">
            <input data-custom="username" data-i="${i}" value="${esc(e.username)}" placeholder="user" dir="ltr" inputmode="latin">
            <input data-custom="password" data-i="${i}" value="${esc(e.password)}" placeholder="pass" dir="ltr" inputmode="latin">
            <button class="mini-btn danger" data-act="del-apn" data-i="${i}" type="button">×</button>
          </div>`
          )
          .join('')}
        <button class="mini-btn accent" data-act="add-apn" type="button" style="margin-top:8px">+ افزودن APN</button>
      </div>`
      : '';

  const allNote =
    state.operatorId === 'all'
      ? `<p class="hint">این گزینه چند APN را کنار هم می‌گذارد و سازگاری آن تأیید نشده است. برای عیب‌یابی، اپراتور همان سیم‌کارت داده را انتخاب کنید.</p>`
      : '';

  const activeOp = OPERATORS.find((o) => o.id === state.operatorId);
  const apnList = activeApnList();

  const summary = summaryHtml();

  // APN values are community defaults until someone confirms them on a real SIM; say so on the
  // screen where the choice is made, not only in the docs nobody opens.
  const verify = verificationOf(state.operatorId);
  const sourcesNote = verify.verified
    ? `<p class="hint">APN این اپراتور با سیم‌کارت واقعی تأیید شده است${verify.verifiedAt ? ` (${esc(verify.verifiedAt)})` : ''}.</p>`
    : verify.kind === 'custom'
      ? ''
      : `<p class="hint">APN این اپراتور با سیم‌کارت واقعی تأیید نشده است و از مقدار رایج جامعه آمده. اگر بعد از نصب آنتن نیامد، از پشتیبانی اپراتور مقدار APN را بپرسید و در «تنظیمات پیشرفته» با گزینه «سایر اپراتورها» وارد کنید.</p>`;

  const iosNote = (() => {
    const major = detectIosMajor();
    if (!major) return '';
    const rec = formatForIos(major);
    return `<p class="hint">iOS ${fa(major)} شناسایی شد؛ قالب پیشنهادی: ${esc(FORMATS.find((f) => f.id === rec)?.fa || rec)}</p>`;
  })();

  view.innerHTML = `
    ${recoverHtml}
    <section class="block">
      <h2 class="block-title">اپراتور سیم‌کارت</h2>
      <div class="grid">${cards}</div>
    </section>
    ${customBlock}
    ${allNote}
    ${sourcesNote}
    ${iosNote}
    <section class="block reference-presets">
      <h2 class="block-title">تنظیمات سریع اپراتور</h2>
      <div class="diagnostic-choices">
        <button class="mini-btn" type="button" data-act="reference" data-value="mci" aria-pressed="${state.preset === 'reference' && state.operatorId === 'mci'}">همراه اول</button>
        <button class="mini-btn" type="button" data-act="reference" data-value="irancell" aria-pressed="${state.preset === 'reference' && state.operatorId === 'irancell'}">ایرانسل</button>
        <button class="mini-btn" type="button" data-act="simple" aria-pressed="${state.preset === 'simple'}">ساختار ساده برای اپراتور انتخاب‌شده</button>
      </div>
      <p class="hint">اپراتور را انتخاب کنید، سپس روی «ساخت پروفایل» بزنید.</p>
    </section>
    ${diagnosticsHtml()}
    <details class="adv" ${state.advanced ? 'open' : ''}>
      <summary>تنظیمات پیشرفته</summary>
      <div class="adv-body">
        <div class="field">
          <label id="lbl-format">قالب پروفایل</label>
          ${selectHtml('format', 'lbl-format')}
        </div>
        <div class="row-2">
          <div class="field">
            <label id="lbl-protocol">پروتکل</label>
            ${selectHtml('protocol', 'lbl-protocol')}
          </div>
          <div class="field">
            <label id="lbl-auth">احراز هویت</label>
            ${selectHtml('auth', 'lbl-auth')}
          </div>
        </div>
        <div class="row-2">
          <div class="field">
            <label>سرور پروکسی <span class="sub">اختیاری</span></label>
            <input data-bind="proxy" value="${esc(state.proxy)}" placeholder="127.0.0.1" dir="ltr" inputmode="latin">
          </div>
          <div class="field">
            <label>پورت</label>
            <input data-bind="proxyPort" value="${esc(state.proxyPort)}" placeholder="8080" dir="ltr" inputmode="numeric">
          </div>
        </div>
        <p class="hint">پروکسی در ساختار سلولی فقط آدرس و پورت می‌گیرد؛ احراز هویت پروکسی پشتیبانی نمی‌شود.</p>
        <div class="field">
          <label>تاریخ انقضای پروفایل <span class="sub">اختیاری</span></label>
          <input type="date" data-bind="removalDate" value="${esc(state.removalDate)}">
        </div>
        <div class="switch">
          <span class="switch-label">بدون اطلاعات ورود APN <small>نام کاربری و رمز در فایل قرار نگیرد</small></span>
          <input type="checkbox" data-bind="omitCredentials" ${state.omitCredentials ? 'checked' : ''}>
          <span class="track"></span>
        </div>
        <div class="switch">
          <span class="switch-label">464XLAT <small>برای شبکه‌های IPv6 اپراتورهای ایرانی</small></span>
          <input type="checkbox" data-bind="xlat" ${state.xlat ? 'checked' : ''}>
          <span class="track"></span>
        </div>
        <div class="switch">
          <span class="switch-label">AttachAPN <small>استفاده از همین APN برای اتصال اولیه، وابسته به پشتیبانی اپراتور</small></span>
          <input type="checkbox" data-bind="attach" ${state.attach ? 'checked' : ''}>
          <span class="track"></span>
        </div>
        <div class="switch">
          <span class="switch-label">آیکون میان‌بر <small>افزودن Web Clip روی صفحه اصلی</small></span>
          <input type="checkbox" data-bind="webClip" ${state.webClip ? 'checked' : ''}>
          <span class="track"></span>
        </div>
      </div>
    </details>
    <p class="hint">این ابزار برای تنظیم APN آیفون است. هر فایل UUID تازه دارد؛ این شناسه مجوز اتصال شبکه یا تضمین بازگشت آنتن نیست. تنظیمات فایل برای بازیابی در همین مرورگر ذخیره می‌شوند.</p>
    ${summary}
    <div class="cta-bar">
      <button class="cta" id="buildBtn" type="button">ساخت پروفایل اختصاصی</button>
    </div>
  `;
}

function diagnosticsHtml() {
  const symptoms = { data: 'آنتن هست، اینترنت نیست', service: 'بدون سرویس یا SOS', unstable: 'اتصال می‌آید و می‌رود' };
  const advice = {
    data: 'دادهٔ همراه، اعتبار بسته و سیم‌کارت انتخاب‌شده برای اینترنت را بررسی کنید. APN را از اپراتور بگیرید. اگر پروفایل قبلی دارید، قبل از آزمایش آن را حذف کنید.',
    service: 'APN معمولاً تنظیم اینترنت است؛ پیام SOS یا No Service به بررسی پوشش، فعال بودن سیم‌کارت و وضعیت دستگاه نزد اپراتور نیاز دارد. این فایل IMEI را تغییر نمی‌دهد و مسدودی شبکه را برنمی‌دارد.',
    unstable: 'زمان بازگشت و افتادن را با دکمه‌های گزارش ثبت کنید. پوشش، تغییر شبکه و وضعیت سیم‌کارت را بررسی کنید؛ از صرف آمدن و رفتن آنتن نمی‌توان علت را تشخیص داد.'
  };
  return `<details class="adv diagnostics" ${state.symptom ? 'open' : ''}>
    <summary>عیب‌یابی اتصال و آزمایش سازگاری</summary>
    <div class="adv-body">
      <p class="hint">این فایل مخصوص iPhone و iPad سلولی است؛ برای اندروید باید APN را از تنظیمات خود گوشی تغییر دهید. وب‌سایت وضعیت مودم را نمی‌بیند.</p>
      <div class="diagnostic-choices">${Object.entries(symptoms).map(([id, label]) => `<button type="button" class="mini-btn" data-act="symptom" data-value="${id}" aria-pressed="${state.symptom === id}">${label}</button>`).join('')}</div>
      ${state.symptom ? `<p class="diagnostic-advice" role="status">${advice[state.symptom] || ''}</p>` : ''}
      <div class="field"><label for="deviceModel">مدل گوشی برای گزارش، اختیاری</label><input id="deviceModel" data-bind="deviceModel" maxlength="60" value="${esc(state.deviceModel || '')}" placeholder="مثلاً iPhone 13"></div>
      <p class="hint">هر بار فقط یک تنظیم را عوض کنید، فایل بسازید و پس از نصب نتیجه را ثبت کنید. این‌ها آزمایش‌اند و ممکن است اتصال را بهتر نکنند.</p>
      <div class="diagnostic-choices">
        <button class="mini-btn" type="button" data-act="trial" data-value="ipv4">آزمایش فقط IPv4</button>
        <button class="mini-btn" type="button" data-act="trial" data-value="no-attach">آزمایش بدون AttachAPN</button>
        <button class="mini-btn" type="button" data-act="trial" data-value="defaults">بازگشت به پیش‌فرض اپراتور</button>
      </div>
    </div>
  </details>`;
}

/* ---------- guide ---------- */

function renderGuide() {
  const matrix = IOS_MATRIX.map(
    (m) => `<div class="card">
      <h3>${esc(m.range)}</h3>
      <p>${esc(m.models)}</p>
      <p class="muted">${esc(m.note)} · قالب: ${esc(m.format)}</p>
    </div>`
  ).join('');

  view.innerHTML = `
    <section class="block">
      <h2 class="block-title">نصب پروفایل</h2>
      <ol class="steps">
        <li><b>ساخت:</b> اپراتور را انتخاب کنید و «ساخت پروفایل اختصاصی» را بزنید.</li>
        <li><b>دانلود:</b> Safari پیام Profile Downloaded را نشان می‌دهد.</li>
        <li><b>نصب:</b> <bdi dir="ltr">Settings → General → VPN &amp; Device Management → Downloaded Profile</bdi> و بعد Install.</li>
        <li><b>بررسی:</b> اتصال اینترنت را آزمایش کنید و نتیجه را در صفحه ثبت کنید.</li>
        <li><b>آزمایش بعدی:</b> پروفایل آزمایشی قبلی را حذف کنید تا تنظیمات روی هم انباشته نشوند.</li>
      </ol>
    </section>
    <section class="block">
      <h2 class="block-title">سازگاری نسخه‌ها</h2>
      ${matrix}
      <div class="card">
        <h3>قالب universal</h3>
        <p>همه قالب‌ها از آرایه APNs در ساختار رسمی Cellular اپل استفاده می‌کنند. قالب legacy کلید 464XLAT را حذف می‌کند. پذیرش تنظیمات به نسخه سیستم و اپراتور بستگی دارد؛ اعتبار ساختار فایل به معنی تأیید عملکرد روی همه نسخه‌ها نیست.</p>
      </div>
    </section>
    <section class="block">
      <h2 class="block-title">وقتی آنتن پایدار نیست</h2>
      <div class="card"><p>از بخش عیب‌یابی، نشانه را انتخاب کنید. پوشش، وضعیت سیم‌کارت و APN را بررسی کنید. برای مقایسه، تنها یک پروفایل آزمایشی را نگه دارید و هر بار یک تنظیم را تغییر دهید.</p></div>
    </section>
    <section class="block">
      <h2 class="block-title">حالت نگهبان، تا حد ممکن خودکار</h2>
      <div class="card">
        <p>نگهبان وقتی صفحه باز و فعال باشد، فایل تازه را در همین مرورگر آماده نگه می‌دارد. iOS ممکن است اجرای صفحه در پس‌زمینه را متوقف کند. پس از بازگشت به صفحه، تازگی فایل بررسی می‌شود. نصب در Settings همچنان دستی است.</p>
        <p class="muted" style="margin-top:8px">چرا هیچ‌چیز کاملاً بی‌تپ نمی‌شود: iOS نصب پروفایل را بدون تأیید انجام نمی‌دهد، مگر دستگاه زیر MDM باشد.</p>
      </div>
    </section>
    <section class="block">
      <h2 class="block-title">وقتی آنتن برنمی‌گردد</h2>
      <div class="card">
        <p>اگر پروفایل نصب شد و آنتن اصلاً نیامد، این چهار بررسی را به ترتیب انجام دهید:</p>
        <ol class="steps" style="margin-top:8px">
          <li><b>APN اپراتور:</b> مقدار دقیق را از پشتیبانی اپراتور بگیرید؛ مقادیر پیش‌فرض هنوز با سیم‌کارت واقعی تأیید نشده‌اند.</li>
          <li><b>نوع مشکل:</b> آنتن بدون اینترنت را از SOS یا No Service جدا کنید؛ دومی می‌تواند از پوشش یا محدودیت شبکه باشد.</li>
          <li><b>نصب واقعی:</b> در <bdi dir="ltr">VPN &amp; Device Management</bdi> ببینید پروفایل با همان APN نشسته باشد.</li>
          <li><b>گزارش:</b> بعد از نصب، نتیجه را در شیت یا تاریخچه ثبت کنید و گزارش را کپی کنید. یک نتیجه به‌تنهایی علت مشکل را اثبات نمی‌کند.</li>
        </ol>
      </div>
    </section>
    <section class="block">
      <h2 class="block-title">وضعیت نگهبان ابری</h2>
      <div class="card">
        <p>ثبت مدیریت دستگاه در این نسخه غیرفعال است. مسیر آزمایشی MDM هنوز برای احراز هویت، سازگاری پروتکل و نصب روی آیفون واقعی تأیید نشده است.</p>
      </div>
    </section>
    <section class="block">
      <h2 class="block-title">نگهداری طولانی‌مدت</h2>
      <div class="card">
        <p>مدت اتصال قابل تضمین نیست. پروفایل APN مجوز رجیستری یا هویت دستگاه را عوض نمی‌کند. اگر شبکه IMEI را مسدود کرده باشد، تکرار نصب راه‌حل رفع آن نیست.</p>
        <p class="muted">لینک <bdi dir="ltr">#recover</bdi> فقط ساخت فایل تازه با تنظیمات آخر را آغاز می‌کند؛ نصب دستی است و اتصال را تضمین نمی‌کند.</p>
      </div>
    </section>
    <section class="block">
      <h2 class="block-title">اپراتورهای خارج از فهرست</h2>
      <div class="card"><p>گزینه «سایر اپراتورها» را انتخاب کنید و APN را دستی وارد کنید. اگر نام APN را نمی‌دانید، از صفحه تنظیمات سیم‌کارت یا سایت اپراتور بردارید؛ هر APN فقط از حروف انگلیسی، رقم، نقطه و خط تیره ساخته می‌شود.</p></div>
    </section>
  `;
}

/* ---------- history ---------- */

/** the field-test summary: what a tester needs to paste into the channel */
function testBlock() {
  const { today, last, avg, ups, fails } = dropStats();
  if (!state.drops.length) {
    return `<div class="card" style="margin-bottom:12px">
      <h3>آمار تست</h3>
      <p class="muted">بعد از نصب، نتیجه را در شیت یا همان ردیف تاریخچه ثبت کنید. مدت اتصال فقط از زمان گزارش «آنتن آمد» تا گزارش افتادن محاسبه می‌شود.</p>
    </div>`;
  }
  return `<div class="card" style="margin-bottom:12px">
    <h3>آمار تست</h3>
    ${last?.profileId && Number.isFinite(last.uptime) ? `<div class="kv"><span>اتصال گزارش‌شدهٔ آخر</span><span>${durationLabel(last.uptime)}</span></div>` : '<p class="muted">مدت اتصال اندازه‌گیری نشده است.</p>'}
    <div class="kv"><span>افتادن در ۲۴ ساعت</span><span>${fa(today)}</span></div>
    <div class="kv"><span>گزارش بازگشت در ۲۴ ساعت</span><span>${fa(ups)}</span></div>
    <div class="kv"><span>نصب بی‌نتیجه در ۲۴ ساعت</span><span>${fa(fails)}</span></div>
    ${avg ? `<div class="kv"><span>میانگین اتصال گزارش‌شده</span><span>${durationLabel(avg)}</span></div>` : ''}
    <div class="hist-actions" style="margin-top:10px">
      <button class="mini-btn accent" data-act="copy-report" type="button">کپی گزارش</button>
    </div>
  </div>`;
}

function renderHistory() {
  const scope = STATIC
    ? '<p class="hint">این فهرست فقط در همین مرورگر روی همین دستگاه ذخیره می‌شود؛ نه به سرور می‌رود و نه با کاربر دیگری مشترک است. پاک‌کردن داده‌های سایت هم آن را پاک می‌کند.</p>'
    : '';

  if (!state.history.length) {
    view.innerHTML = `
      <div class="empty">
        <svg viewBox="0 0 24 24" width="42" height="42"><circle cx="12" cy="12" r="8" stroke="currentColor" stroke-width="1.2" fill="none"/><path d="M12 8v4.4l3 1.8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" fill="none"/></svg>
        <div>هنوز پروفایلی نساخته‌اید.</div>
      </div>
      ${scope}`;
    return;
  }

  view.innerHTML =
    testBlock() +
    state.history
      .map((h) => {
        const op = OPERATORS.find((o) => o.id === h.operatorId);
        const date = new Date(h.createdAt).toLocaleString('fa-IR', { dateStyle: 'short', timeStyle: 'short' });
        return `<div class="hist-item">
        <div class="hist-top">
          <span class="hist-title">${esc(op ? op.fa : h.operatorId)} ${h.local ? '<span class="badge off">محلی</span>' : ''}</span>
          <span class="badge on">${esc(h.format || 'universal')}</span>
        </div>
        <div class="hist-meta">${esc(h.uuid || h.id)}</div>
        <div class="hist-meta" style="direction:rtl;font-family:inherit">${esc(date)} · ${ageLabel(h.createdAt)}</div>
        <div class="hist-actions">
          ${h.url ? `<a class="mini-btn accent" href="${esc(h.url)}" rel="noopener">دانلود دوباره</a>` : ''}
          <button class="mini-btn" data-act="copy-uuid" data-uuid="${esc(h.uuid || h.id)}" type="button">کپی UUID</button>
          <button class="mini-btn" data-act="report-up" data-id="${esc(h.id)}" type="button">نصب کردم، آنتن آمد</button>
          <button class="mini-btn" data-act="report-fail" data-id="${esc(h.id)}" type="button">نصب کردم، نتیجه نداد</button>
          <button class="mini-btn" data-act="rebuild" data-op="${esc(h.operatorId)}" data-id="${esc(h.id)}" type="button">پروفایل تازه</button>
          <button class="mini-btn danger" data-act="del-hist" data-id="${esc(h.id)}" type="button">حذف</button>
        </div>
      </div>`;
      })
      .join('') + scope;
}

/* ---------- about ---------- */

function renderAbout() {
  view.innerHTML = `
    <div class="card">
      <h3>آنتن · iRegister</h3>
      <p>مولد پروفایل APN برای آیفون، همراه با عیب‌یابی و ثبت نتیجهٔ آزمایش. این ابزار وضعیت مودم را نمی‌خواند و بازگشت یا پایداری آنتن را تضمین نمی‌کند.</p>
    </div>
    <div class="card">
      <h3>وضعیت سرویس</h3>
      <p id="healthLine">در حال بررسی…</p>
      <div class="chips" id="healthChips"></div>
    </div>
    <div class="card">
      <h3>نسخه</h3>
      <p class="muted">1.1.0 · عیب‌یابی اتصال، گزارش تست و بازیابی تنظیمات · سه قالب خروجی</p>
    </div>
    <div class="card">
      <h3>حق نشر</h3>
      <p class="muted">متن‌ها، پروفایل‌ها و طراحی از کانال AmyraxVPN است. بازنشر با ذکر منبع مانعی ندارد.</p>
      <a class="cloud-row" href="https://t.me/AmyraxVPN" target="_blank" rel="noopener">
        <div>
          <b>کانال AmyraxVPN</b>
          <span dir="ltr">t.me/AmyraxVPN</span>
        </div>
        <span class="cloud-go" aria-hidden="true">›</span>
      </a>
    </div>
    <footer class="footnote">© ۱۴۰۵ کانال AmyraxVPN · ${STATIC ? 'پروفایل‌ها در خود مرورگر ساخته می‌شوند' : 'پروفایل‌ها روی سرور خودتان تولید می‌شوند'}</footer>
  `;

  if (STATIC) {
    const line = document.getElementById('healthLine');
    if (line) line.textContent = 'نسخه‌ی استاتیک؛ پروفایل در مرورگر و بدون سرور ساخته می‌شود.';
    return;
  }

  api('/api/health')
    .then((h) => {
      const line = document.getElementById('healthLine');
      const chips = document.getElementById('healthChips');
      if (!line) return;
      line.textContent = h.ok ? 'سرویس فعال است.' : 'سرویس با خطا بالا آمده است.';
      chips.innerHTML = `
        <span class="badge ${h.signing ? 'on' : 'off'}">امضا: ${h.signing ? 'فعال' : 'خاموش'}</span>
        <span class="badge ${h.binding ? 'on' : 'off'}">قفل دستگاه: ${h.binding ? 'فعال' : 'خاموش'}</span>
        <span class="badge">اپراتور: ${fa(h.operators)}</span>`;
    })
    .catch(() => {
      const line = document.getElementById('healthLine');
      if (line) line.textContent = 'سرور در دسترس نیست؛ ساخت محلی فعال است.';
    });
}

/* ---------- events ---------- */

document.getElementById('tabbar').addEventListener('click', (event) => {
  const btn = event.target.closest('.tab');
  if (!btn) return;
  state.tab = btn.dataset.tab;
  render();
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

view.addEventListener('click', (event) => {
  const target = event.target;

  const selBtn = target.closest('.sel-btn');
  if (selBtn) {
    const sel = selBtn.closest('.sel');
    if (selBtn.getAttribute('aria-expanded') === 'true') closeSelects();
    else openSelect(sel);
    return;
  }

  const selOpt = target.closest('.sel-menu [role="option"]');
  if (selOpt) {
    commitSelect(selOpt.closest('.sel'), selOpt.dataset.value);
    return;
  }

  if (!target.closest('.sel')) closeSelects();

  // action buttons carry data-op too; they must fall through to the data-act branch
  const opBtn = target.closest('[data-op]:not([data-act])');
  if (opBtn) {
    if (state.preset) Object.assign(state, simpleOptions(opBtn.dataset.op));
    else { state.operatorId = opBtn.dataset.op; state.auth = 'PAP'; }
    renderBuild();
    return;
  }

  if (target.closest('#buildBtn')) {
    handleBuild();
    return;
  }

  const act = target.closest('[data-act]');
  if (act) {
    const kind = act.dataset.act;
    if (kind === 'simple') {
      Object.assign(state, simpleOptions(state.operatorId));
      renderBuild();
      toast('ساختار ساده اعمال شد؛ اکنون پروفایل بسازید');
      return;
    }
    if (kind === 'reference') {
      Object.assign(state, referenceOptions(act.dataset.value));
      renderBuild();
      toast('تنظیمات اپراتور اعمال شد؛ اکنون پروفایل بسازید');
      return;
    }
    if (kind === 'symptom') {
      state.symptom = act.dataset.value;
      renderBuild();
      view.querySelector(`[data-act="symptom"][data-value="${state.symptom}"]`)?.focus();
      return;
    }
    if (kind === 'trial') {
      state.preset = '';
      if (act.dataset.value === 'ipv4') state.protocol = 'ipv4';
      if (act.dataset.value === 'no-attach') state.attach = false;
      if (act.dataset.value === 'defaults') {
        Object.assign(state, simpleOptions(state.operatorId));
      }
      state.advanced = true;
      renderBuild();
      toast('تنظیم آزمایش اعمال شد؛ برای دریافت فایل، ساخت پروفایل را بزنید');
      return;
    }
    if (kind === 'add-apn') {
      if (state.customEntries.length >= 8) { toast('حداکثر ۸ APN مجاز است', true); return; }
      state.customEntries.push({ apn: '', username: '', password: '' });
      renderBuild();
    }
    if (kind === 'del-apn') {
      const i = Number(act.dataset.i);
      state.customEntries.splice(i, 1);
      if (!state.customEntries.length) state.customEntries.push({ apn: '', username: '', password: '' });
      renderBuild();
    }
    if (kind === 'copy-uuid') {
      navigator.clipboard?.writeText(act.dataset.uuid || '').then(
        () => toast('UUID کپی شد'),
        () => toast('کپی نشد', true)
      );
    }
    if (kind === 'copy-report') {
      copyReport();
    }
    if (kind === 'report-up' || kind === 'report-fail') {
      state.activeProfileId = act.dataset.id;
      recordOutcome(kind === 'report-up' ? 'up' : 'fail');
      toast(kind === 'report-up' ? 'ثبت شد: آنتن آمد' : 'ثبت شد: آنتن نیامد');
      if (state.tab === 'history') renderHistory();
      return;
    }
    if (kind === 'rebuild') {
      // this tap is the user reporting a drop, so it is the measurement point
      recordDrop(act.dataset.op || state.operatorId, act.dataset.id);
      state.operatorId = act.dataset.op || state.operatorId;
      restoreSettings(state.history.find((h) => h.id === act.dataset.id) || state.history.find((h) => h.operatorId === state.operatorId));
      state.tab = 'build';
      render();
      setTimeout(handleBuild, 60);
    }
    if (kind === 'install-ready') {
      const ready = state.ready;
      if (!readyFresh() || !ready.xml) { primeGuard(); toast('فایل تازه در حال آماده‌سازی است'); return; }
      if (!state.history.some((h) => h.id === ready.id)) {
        saveHistory([profileHistory(ready.id, ready.id, ready.settings, ready.entries, { local: true }), ...state.history]);
      }
      state.activeProfileId = ready.id;
      downloadBlob(ready.xml, `anten-${ready.id.slice(0, 8)}.mobileconfig`);
      openSheet('پروفایل آماده', installSheetHtml(ready.entries || [], ready.format || 'universal'));
      return;
    }
    if (kind === 'toggle-guard') {
      state.guard = !state.guard;
      if (!state.guard) state.ready = null;
      saveGuard();
      renderBuild();
      if (state.guard) {
        toast('نگهبان روشن شد');
        primeGuard();
      } else {
        toast('نگهبان خاموش شد');
      }
      return;
    }
    if (kind === 'del-hist') {
      saveHistory(state.history.filter((h) => h.id !== act.dataset.id));
      renderHistory();
      toast('از تاریخچه حذف شد');
    }
  }
});

view.addEventListener('keydown', (event) => {
  const sel = event.target.closest('.sel');
  if (!sel) return;
  const btn = sel.querySelector('.sel-btn');
  const menu = sel.querySelector('.sel-menu');
  const items = [...menu.querySelectorAll('[role="option"]')];
  const open = btn.getAttribute('aria-expanded') === 'true';
  const index = items.indexOf(document.activeElement);

  if (event.key === 'Escape' && open) {
    event.preventDefault();
    event.stopPropagation();
    closeSelects();
    btn.focus({ preventScroll: true });
    return;
  }

  if (!open) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openSelect(sel);
    }
    return;
  }

  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    const step = event.key === 'ArrowDown' ? 1 : -1;
    const next = items[(index + step + items.length) % items.length];
    items.forEach((li) => li.classList.remove('is-active'));
    next.classList.add('is-active');
    next.focus({ preventScroll: true });
    return;
  }

  if (event.key === 'Home' || event.key === 'End') {
    event.preventDefault();
    const next = event.key === 'Home' ? items[0] : items[items.length - 1];
    items.forEach((li) => li.classList.remove('is-active'));
    next.classList.add('is-active');
    next.focus({ preventScroll: true });
    return;
  }

  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    if (index >= 0) commitSelect(sel, items[index].dataset.value);
    return;
  }

  if (event.key === 'Tab') closeSelects();
});

document.addEventListener('click', (event) => {
  if (!event.target.closest('.sel')) closeSelects();
});

view.addEventListener('input', (event) => {
  const el = event.target;
  if (el.dataset.custom || (el.dataset.bind && el.dataset.bind !== 'deviceModel')) markCustomSettings();

  if (el.dataset.custom) {
    const i = Number(el.dataset.i);
    const field = el.dataset.custom;
    if (state.customEntries[i]) state.customEntries[i][field] = el.value;
  }

  if (el.dataset.bind) {
    const key = el.dataset.bind;
    if (!['format', 'protocol', 'auth', 'xlat', 'attach', 'webClip', 'omitCredentials'].includes(key)) state[key] = el.value;
  }
});

view.addEventListener('change', (event) => {
  const el = event.target;
  const key = el.dataset.bind;
  if (!key) return;

  if (key !== 'deviceModel') markCustomSettings();
  if (['xlat', 'attach', 'webClip', 'omitCredentials'].includes(key)) {
    state[key] = el.checked;
    return;
  }
  if (key === 'format' || key === 'protocol' || key === 'auth') {
    state[key] = el.value;
    return;
  }
  state[key] = el.value;
});

document.addEventListener('toggle', (event) => {
  if (event.target.classList && event.target.classList.contains('adv') && !event.target.classList.contains('diagnostics')) {
    state.advanced = event.target.open;
  }
}, true);

function markCustomSettings() {
  state.preset = '';
  for (const button of view.querySelectorAll('[data-act="reference"], [data-act="simple"]')) button.setAttribute('aria-pressed', 'false');
}

sheet.addEventListener('click', (event) => {
  if (event.target.closest('[data-close]')) closeSheet();
  const action = event.target.closest('[data-act]')?.dataset.act;
  if (action === 'report-up' || action === 'report-fail') {
    recordOutcome(action === 'report-up' ? 'up' : 'fail');
    toast('نتیجهٔ نصب ثبت شد');
    closeSheet();
  }
});

async function copyReport() {
  const report = testReport();
  try {
    if (!navigator.clipboard) throw new Error('clipboard unavailable');
    await navigator.clipboard.writeText(report);
    toast('گزارش کپی شد');
  } catch {
    openSheet('گزارش تست، برای کپی انتخاب کنید', `<pre class="report-text" dir="rtl">${esc(report)}</pre>`);
  }
}

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !sheet.hidden) {
    event.preventDefault();
    closeSheet();
  }
});

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'light' ? '#f3f4f5' : '#0c0e10');
}

document.getElementById('themeBtn').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  applyTheme(next);
  try { localStorage.setItem(THEME_KEY, next); } catch { /* theme still works in memory */ }
});

document.getElementById('statusBtn').addEventListener('click', async () => {
  if (STATIC) {
    openSheet(
      'وضعیت',
      '<p>این نسخه کاملاً در مرورگر کار می‌کند: نه سروری در میان است و نه چیزی از دستگاه شما جایی ذخیره می‌شود. پروفایل با همان سازنده‌ی اصلی ساخته می‌شود، فقط بدون امضای تجاری و بدون قفل دستگاه.</p>'
    );
    return;
  }
  openSheet('وضعیت سرویس', '<p>در حال بررسی…</p>');
  try {
    const h = await api('/api/health');
    sheetBody.innerHTML = `
      <div class="result ${h.ok ? 'ok' : 'bad'}" style="margin-bottom:12px">
        <div class="kv"><span>سرویس</span><span>${h.ok ? 'فعال' : 'خطا'}</span></div>
        <div class="kv"><span>نسخه</span><span>${esc(h.version)}</span></div>
        <div class="kv"><span>اپراتورها</span><span>${fa(h.operators)}</span></div>
        <div class="kv"><span>امضا</span><span>${h.signing ? 'فعال' : 'خاموش'}</span></div>
        <div class="kv"><span>قفل دستگاه</span><span>${h.binding ? 'فعال' : 'خاموش'}</span></div>
        <div class="kv"><span>آپ‌تایم</span><span>${fa(h.uptimeSeconds)} ثانیه</span></div>
      </div>
      <p class="muted">اگر امضا خاموش است، پروفایل‌ها بدون امضای تجاری نصب می‌شوند و iOS هشدار Unsigned می‌دهد.</p>`;
  } catch {
    sheetBody.innerHTML = '<p>سرور پاسخ نداد. اپ در حالت محلی کار می‌کند.</p>';
  }
});

/* ---------- boot ---------- */

(function boot() {
  let savedTheme;
  try { savedTheme = localStorage.getItem(THEME_KEY); } catch { /* storage may be disabled */ }
  if (savedTheme) applyTheme(savedTheme);

  const forcedTheme = new URLSearchParams(location.search).get('theme');
  if (forcedTheme === 'light' || forcedTheme === 'dark') {
    applyTheme(forcedTheme);
  }

  const hash = location.hash.replace('#', '').toLowerCase();
  if (['guide', 'history', 'about'].includes(hash)) state.tab = hash;

  const major = detectIosMajor();
  if (major && !state.preset) state.format = formatForIos(major);
  restoreSettings(state.history[0]);

  render();

  // #recover is the Shortcuts target: reopen the app and mint a fresh profile for the last operator
  if (hash === 'recover' && state.history.length) {
    state.operatorId = state.history[0].operatorId;
    restoreSettings(state.history[0]);
    renderBuild();
    setTimeout(handleBuild, 80);
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register(new URL('./sw.js', location.href), { updateViaCache: 'none' }).catch(() => {});
  }

  startWatch();
  pingNow();
  primeGuard();

  // handle for the UI gate and for debugging in the console
  window.__ir = { state, handleBuild, pingNow, primeGuard, recordDrop, recordOutcome, dropStats, testReport };
})();
