/* language: JavaScript (ES2022) | file: scripts/check-ui-flow.mjs | runtime: Node 22+
   click-through gate: drives the real UI in headless chrome and records what each control did.
   usage: node scripts/check-ui-flow.mjs [baseUrl] */

import { spawn } from 'node:child_process';
import fs from 'node:fs';

const BASE = process.argv[2] || 'http://127.0.0.1:8787/';
const port = 9600 + Math.floor(Math.random() * 300);
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const downloadDir = `${process.env.TEMP}\\ir-dl-${Date.now()}`;
fs.mkdirSync(downloadDir, { recursive: true });

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${process.env.TEMP}\\ir-ui-${Date.now()}`,
    'about:blank'
  ],
  { stdio: 'ignore' }
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let page;
for (let i = 0; i < 40 && !page; i += 1) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  } catch {
    /* retry */
  }
  if (!page) await sleep(250);
}
if (!page) throw new Error('no devtools target');

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});

let seq = 0;
const pending = new Map();
const events = [];
const consoleErrors = [];
const netLog = [];
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
    return;
  }
  if (!msg.method) return;
  events.push(msg);
  if (msg.method === 'Runtime.exceptionThrown') consoleErrors.push(msg.params?.exceptionDetails?.text || 'exception');
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
    consoleErrors.push(msg.params.args?.map((a) => a.value ?? a.description).join(' ') || 'console.error');
  }
  if (msg.method === 'Log.entryAdded' && msg.params?.entry?.level === 'error') {
    consoleErrors.push(msg.params.entry.text);
  }
  if (msg.method === 'Network.requestWillBeSent' && msg.params?.request?.url?.includes('/api/profile')) {
    netLog.push(`sent ${msg.params.requestId} ${msg.params.request.method}`);
  }
  if (msg.method === 'Network.responseReceived' && msg.params?.response?.url?.includes('/api/profile')) {
    netLog.push(`res ${msg.params.requestId} ${msg.params.response.status}`);
  }
  if (msg.method === 'Network.loadingFailed') {
    netLog.push(`fail ${msg.params.requestId} ${msg.params.errorText}${msg.params.canceled ? ' canceled' : ''}`);
  }
};

const send = (method, params = {}) => {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve) => pending.set(id, resolve));
};

const evaluate = async (expression) => {
  const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return res.result?.result?.value;
};

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
};

await send('Page.enable');
await send('Runtime.enable');
await send('Log.enable');
await send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: downloadDir, eventsEnabled: true });
await send('Emulation.setDeviceMetricsOverride', { width: 430, height: 932, deviceScaleFactor: 2, mobile: true });
await send('Page.navigate', { url: BASE });
await sleep(2200);

/* 1. shell */
check('page title', (await evaluate('document.title')).includes('آنتن'));
check('h1 present', (await evaluate(`document.querySelectorAll('main h1, header h1').length`)) >= 1);
check('8 operator cells', (await evaluate(`document.querySelectorAll('.op-card').length`)) === 8);
check('build button', (await evaluate(`Boolean(document.getElementById('buildBtn'))`)) === true);

await evaluate(`document.fonts.ready.then(() => true)`);
const controlFonts = await evaluate(
  `['.op-card .op-name', '.sel-btn', '#buildBtn', '.tab', '.brand h1'].map((s) => { const el = document.querySelector(s); return s + '=' + (el ? getComputedStyle(el).fontFamily : 'missing'); })`
);
check(
  'buttons use Vazirmatn too',
  Array.isArray(controlFonts) && controlFonts.every((f) => f.includes('Vazirmatn')),
  controlFonts.join(' | ')
);

/* 2. operator select */
await evaluate(`document.querySelector('[data-op="irancell"]').click()`);
await sleep(250);
check('operator selected', (await evaluate(`document.querySelector('[data-op="irancell"]').getAttribute('aria-pressed')`)) === 'true');
check('summary follows selection', (await evaluate(`document.querySelector('.summary').textContent.includes('ایرانسل')`)) === true);

/* 3. theme toggle */
const before = await evaluate(`document.documentElement.dataset.theme`);
await evaluate(`document.getElementById('themeBtn').click()`);
await sleep(200);
const after = await evaluate(`document.documentElement.dataset.theme`);
check('theme toggles', before !== after, `${before} -> ${after}`);
await evaluate(`document.getElementById('themeBtn').click()`);
await sleep(150);

/* 4. advanced panel */
await evaluate(`document.querySelector('.adv:not(.diagnostics) summary').click()`);
await sleep(200);
check('advanced opens', (await evaluate(`document.querySelector('.adv:not(.diagnostics)').open`)) === true);
check('advanced fields', (await evaluate(`document.querySelectorAll('.adv-body input, .adv-body select').length`)) >= 6);

/* 4b. custom listbox: must stay inside the app surface, never an OS menu */
check('no native select left', (await evaluate(`document.querySelectorAll('.adv-body select').length`)) === 0);
await evaluate(`document.querySelector('[data-sel="format"] .sel-btn').click()`);
await sleep(200);
check('menu opens in page', (await evaluate(`document.querySelector('[data-sel="format"] .sel-menu').hidden`)) === false);
check(
  'menu is positioned by the app',
  (await evaluate(`getComputedStyle(document.querySelector('[data-sel="format"] .sel-menu')).position`)) === 'absolute'
);
check(
  'menu paints above the form',
  (await evaluate(`Number(getComputedStyle(document.querySelector('[data-sel="format"] .sel-menu')).zIndex) >= 30`)) === true
);
check(
  'menu uses app surface',
  (await evaluate(`getComputedStyle(document.querySelector('[data-sel="format"] .sel-menu')).backgroundColor`)) !== 'rgba(0, 0, 0, 0)'
);
await evaluate(`document.querySelectorAll('[data-sel="format"] [role="option"]')[1].click()`);
await sleep(200);
check(
  'option commits',
  (await evaluate(`document.querySelector('[data-sel="format"] .sel-val').textContent.trim()`)) === 'فقط iOS 16 و بالاتر'
);
check('menu closes after pick', (await evaluate(`document.querySelector('[data-sel="format"] .sel-menu').hidden`)) === true);
check('summary follows pick', (await evaluate(`document.querySelector('.summary').textContent.includes('modern')`)) === true);

/* keyboard path: open with ArrowDown, move with ArrowDown, commit with Enter */
await evaluate(`document.querySelector('[data-sel="protocol"] .sel-btn').focus()`);
await evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))`);
await sleep(200);
check('keyboard opens menu', (await evaluate(`document.querySelector('[data-sel="protocol"] .sel-menu').hidden`)) === false);
await evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))`);
await evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))`);
await sleep(120);
await evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
await sleep(200);
check(
  'keyboard commits option',
  (await evaluate(`document.querySelector('[data-sel="protocol"] .sel-val').textContent.trim()`)) === 'فقط IPv4'
);
check(
  'escape closes menu',
  await evaluate(
    `(() => { const b = document.querySelector('[data-sel="protocol"] .sel-btn'); b.click(); const wasOpen = !document.querySelector('[data-sel="protocol"] .sel-menu').hidden; document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return wasOpen && document.querySelector('[data-sel="protocol"] .sel-menu').hidden; })()`
  )
);

/* value survives a re-render (operator change rebuilds the view) */
await evaluate(`document.querySelector('[data-op="rightel"]').click()`);
await sleep(250);
check(
  'choice survives re-render',
  (await evaluate(`document.querySelector('[data-sel="format"] .sel-val').textContent.trim()`)) === 'فقط iOS 16 و بالاتر'
);
await evaluate(`document.querySelector('[data-op="mci"]').click()`);
await sleep(200);

/* 5. build + sheet */
await evaluate(`document.getElementById('buildBtn').click()`);
let dl = null;
for (let i = 0; i < 24 && !dl; i += 1) {
  await sleep(250);
  dl = events.find((e) => e.method === 'Page.downloadWillBegin');
}
check('download started', Boolean(dl), dl?.params?.suggestedFilename || 'none');
await sleep(900);
check('install sheet opens', (await evaluate(`document.getElementById('sheet').hidden`)) === false);
check('sheet focus moved', (await evaluate(`document.activeElement.closest('#sheet') !== null`)) === true);
check('sheet edge sweep runs', (await evaluate(`getComputedStyle(document.querySelector('.sheet-beam')).animationName`)) === 'sheet-beam');

/* 6. escape closes */
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
await sleep(250);
check('escape closes sheet', (await evaluate(`document.getElementById('sheet').hidden`)) === true);

/* 6b. busy state: hold the request open so the button can be inspected, then release it */
await evaluate(`window.__realFetch = window.fetch; window.__release = null;
  window.fetch = (url, opts) => (String(url).includes('/api/profile')
    ? new Promise((res, rej) => { window.__release = () => window.__realFetch(url, opts).then(res, rej); })
    : window.__realFetch(url, opts));`);
await evaluate(`document.getElementById('buildBtn').click()`);
await sleep(250);
check('cta marks busy', (await evaluate(`document.getElementById('buildBtn').getAttribute('aria-busy')`)) === 'true');
check('busy label', (await evaluate(`document.getElementById('buildBtn').textContent.includes('در حال ساخت')`)) === true);
check(
  'busy sweep runs',
  (await evaluate(`getComputedStyle(document.getElementById('buildBtn'), '::after').animationName`)) === 'cta-sweep'
);
await evaluate(`window.fetch = window.__realFetch; if (window.__release) { window.__release(); window.__release = null; }`);
await sleep(400);

/* 7. tabs */
await evaluate(`document.querySelector('[data-tab="guide"]').click()`);
await sleep(250);
check('guide tab renders', (await evaluate(`document.body.textContent.includes('نصب پروفایل')`)) === true);
await evaluate(`document.querySelector('[data-tab="history"]').click()`);
await sleep(250);
check('history tab renders', (await evaluate(`document.querySelector('.hist-item') !== null || document.querySelector('.empty') !== null`)) === true);
await evaluate(`document.querySelector('[data-tab="about"]').click()`);
await sleep(600);
check('about tab renders', (await evaluate(`document.body.textContent.includes('وضعیت سرویس')`)) === true);

/* 8. back to the builder, then typography checks */
await evaluate(`document.querySelector('[data-tab="build"]').click()`);
await sleep(300);
check('builder returns', (await evaluate(`document.querySelectorAll('.op-card').length`)) === 8);
check('registry mode is gone', (await evaluate(`document.querySelectorAll('[data-mode], .seg-btn, #imeiInput').length`)) === 0);

const fontLoaded = await evaluate(`document.fonts.ready.then(() => document.fonts.check('16px Vazirmatn'))`);
check('Vazirmatn file loads', fontLoaded === true);
const bodyFont = await evaluate(`getComputedStyle(document.body).fontFamily`);
check('body uses Vazirmatn first', /^"?Vazirmatn"?/.test(bodyFont), bodyFont);
const monoFonts = await evaluate(`[...document.querySelectorAll('input, select, pre, .kv b, .hist-meta, .sum-item b')]
  .map((el) => getComputedStyle(el).fontFamily)
  .filter((f) => /mono|consolas|courier/i.test(f))`);
check('no monospace in any control', Array.isArray(monoFonts) && monoFonts.length === 0, String(monoFonts));

/* 9. recovery card: appears after a build, mints a fresh profile on demand */
const recoverLabel = await evaluate(`document.querySelector('.recover .mini-btn')?.textContent.trim()`);
check('recovery card appears after a build', recoverLabel === 'آنتن پرید؟ پروفایل تازه', String(recoverLabel));
const ageText = await evaluate(`document.querySelector('.recover-meta')?.textContent.trim()`);
check('recovery card shows operator and age', /همین حالا|دقیقه پیش|ساعت پیش|دیروز|روز پیش/.test(String(ageText)), String(ageText));
const beforeCount = await evaluate(`JSON.parse(localStorage.getItem('ir.history.v1') || '[]').length`);

const box = await evaluate(`(() => {
  const card = document.querySelector('.recover');
  const btn = document.querySelector('.recover .mini-btn');
  const bar = document.querySelector('.topbar');
  const r = card.getBoundingClientRect();
  const b = btn.getBoundingClientRect();
  return {
    h: Math.round(b.height),
    fits: r.left >= 0 && r.right <= innerWidth,
    belowHeader: r.top >= bar.getBoundingClientRect().bottom - 1,
    overlap: !(b.right <= r.right + 1 && b.left >= r.left - 1)
  };
})()`);
check('recovery button is a 44px target', box.h >= 44, String(box.h));
check('recovery card fits the column and clears the header', box.fits && box.belowHeader, JSON.stringify(box));
check('recovery button sits inside its card', box.overlap === false, JSON.stringify(box));

await evaluate(`(() => { window.__hit = 0; window.__view = 0; document.querySelector('.recover .mini-btn').addEventListener('click', () => { window.__hit += 1; }); document.getElementById('view').addEventListener('click', () => { window.__view += 1; }); })()`);
/* wait for any build started earlier in the run to settle */
for (let i = 0; i < 80; i += 1) {
  if ((await evaluate(`window.__ir.state.busy`)) === false) break;
  await sleep(250);
}
const beforeBusy = await evaluate(`JSON.stringify({ busy: window.__ir.state.busy, pending: window.__ir.state.pendingBuild, mode: window.__ir.state.tab })`);
await evaluate(`document.querySelector('.recover .mini-btn').click()`);
await sleep(120);
const started = await evaluate(`document.getElementById('buildBtn')?.textContent.trim()`);
const sheetOpen = await evaluate(`document.getElementById('sheet').hidden === false`);
const afterBusy = await evaluate(`JSON.stringify({ busy: window.__ir.state.busy, pending: window.__ir.state.pendingBuild })`);
await sleep(1300);
check('recovery starts a build', started === 'در حال ساخت…' || sheetOpen === true, `${started} sheet=${sheetOpen} ${beforeBusy} -> ${afterBusy}`);
const afterCount = await evaluate(`JSON.parse(localStorage.getItem('ir.history.v1') || '[]').length`);
const why = await evaluate(`(() => { const b = document.querySelector('.recover .mini-btn'); return JSON.stringify({ busy: window.__ir.state.busy, pending: window.__ir.state.pendingBuild, local: JSON.parse(localStorage.getItem('ir.history.v1')||'[]').map((h) => h.local === true) }); })()`);
console.log('NET', JSON.stringify(netLog.slice(-8)));
check('recovery button mints a new profile', afterCount === beforeCount + 1, `${beforeCount} -> ${afterCount} ${why}`);
await evaluate(`document.querySelector('[data-tab="history"]').click()`);
await sleep(400);
check('history shows the new entry age', (await evaluate(`/همین حالا|دقیقه پیش/.test(document.body.textContent)`)) === true);

/* 9b. test log: a drop and an install outcome become one copyable report */
{
  const seeded = await evaluate(`(() => {
    window.__ir.state.history.unshift({ id: 'seed', operatorId: 'mci', format: 'universal', createdAt: Date.now() - 14 * 60000 });
    window.__ir.state.activeProfileId = 'seed';
    window.__ir.recordOutcome('up');
    window.__ir.state.drops[0].at = Date.now() - 14 * 60000;
    window.__ir.recordDrop('mci');
    return window.__ir.dropStats();
  })()`);
  check('drop is timed from the reported return', seeded && seeded.last.uptime >= 14 * 60000 && seeded.last.uptime < 15 * 60000, JSON.stringify(seeded));
  check('install outcome is recorded', seeded && seeded.ups === 1, JSON.stringify(seeded));
  const report = await evaluate(`window.__ir.testReport()`);
  check('report carries operator and uptime', /اپراتور: mci/.test(report) && /۱۴ دقیقه/.test(report), report.split('\n')[3]);
  await evaluate(`document.querySelector('[data-tab="history"]').click()`);
  await sleep(350);
  check('history shows the test summary', (await evaluate(`document.body.textContent.includes('آمار تست')`)) === true);
  const copyBtn = await evaluate(`(() => { const b = document.querySelector('[data-act="copy-report"]'); return b ? Math.round(b.getBoundingClientRect().height) : 0; })()`);
  check('report button is a 44px target', copyBtn >= 44, String(copyBtn));
}

/* 10. guard mode: one switch keeps a ready file in hand */
await evaluate(`document.querySelector('[data-tab="build"]').click()`);
await sleep(250);
await evaluate(`document.querySelector('[data-act="toggle-guard"]').click()`);
await sleep(1200);
check('guard switch turns on', (await evaluate(`document.querySelector('[data-act="toggle-guard"]').getAttribute('aria-checked')`)) === 'true');
const ready = await evaluate(`(() => { const b = document.querySelector('[data-act="install-ready"]'); return b ? { label: b.textContent.trim(), h: Math.round(b.getBoundingClientRect().height) } : null; })()`);
check('a ready profile is primed automatically', ready !== null && ready.label === 'دانلود و نصب', JSON.stringify(ready));
check('ready button is a 44px target', ready !== null && ready.h >= 44, JSON.stringify(ready));
await evaluate(`document.querySelector('[data-act="install-ready"]').click()`);
await sleep(350);
check('install opens the sheet without a rebuild', (await evaluate(`document.getElementById('sheet').hidden === false && document.getElementById('sheetTitle').textContent.includes('آماده')`)) === true);
await evaluate(`document.querySelector('.sheet-head .icon-btn').click()`);
await evaluate(`document.querySelector('[data-act="toggle-guard"]').click()`);
await sleep(250);
check('guard switch turns off and drops the ready file', (await evaluate(`document.querySelector('[data-act="install-ready"]') === null`)) === true);
const cloud = await evaluate(`(() => { const a = document.querySelector('[data-guard-link]'); return a ? { href: a.getAttribute('href'), h: Math.round(a.getBoundingClientRect().height) } : null; })()`);
check('unverified cloud enrollment is not offered', cloud === null);

/* Diagnostics changes one field, preserves APN choices and does not download prematurely. */
await evaluate(`document.querySelector('.diagnostics').open = true; document.querySelector('[data-act="symptom"][data-value="service"]').click()`);
check('no service guidance explains the network boundary', (await evaluate(`document.querySelector('.diagnostic-advice').textContent.includes('IMEI')`)) === true);
const beforeTrial = await evaluate(`window.__ir.state.history.length`);
await evaluate(`document.querySelector('[data-act="trial"][data-value="ipv4"]').click()`);
check('IPv4 trial changes protocol without building', (await evaluate(`window.__ir.state.protocol === 'ipv4' && window.__ir.state.history.length === ${beforeTrial}`)) === true);
await evaluate(`document.querySelector('[data-act="trial"][data-value="no-attach"]').click()`);
check('attach trial preserves protocol', (await evaluate(`window.__ir.state.attach === false && window.__ir.state.protocol === 'ipv4'`)) === true);

/* 11. link watchdog: three failed probes surface the recovery banner */await evaluate(`window.__realFetch2 = window.fetch; window.fetch = () => Promise.reject(new Error('down'));`);
await evaluate(`(async () => { await window.__ir.pingNow(); await window.__ir.pingNow(); await window.__ir.pingNow(); })()`);
await evaluate(`document.querySelector('[data-tab="build"]').click()`);
await sleep(300);
check('three failed pings raise the banner', (await evaluate(`!!document.querySelector('.linkdown')`)) === true);
await evaluate(`window.fetch = window.__realFetch2`);

/* 12. credit line in about */
await evaluate(`document.querySelector('[data-tab="about"]').click()`);
await sleep(300);
const credit = await evaluate(`(() => { const a = document.querySelector('a[href*="t.me"]'); return a ? { href: a.getAttribute('href'), blank: a.target, rel: a.rel, h: Math.round(a.getBoundingClientRect().height) } : null; })()`);
check('about credits the channel', credit !== null && credit.href === 'https://t.me/AmyraxVPN', JSON.stringify(credit));
check('credit link opens away safely', credit !== null && credit.blank === '_blank' && /noopener/.test(credit.rel), JSON.stringify(credit));
check('credit link is a 44px target', credit !== null && credit.h >= 44, JSON.stringify(credit));

/* 13. console */
check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));

ws.close();
chrome.kill();

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
