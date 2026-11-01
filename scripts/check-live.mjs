/* language: JavaScript (ES2022) | file: scripts/check-live.mjs | runtime: Node 22+
   opens a published static build in headless chrome and proves it mints a profile with no server.
   usage: node scripts/check-live.mjs https://user.github.io/repo/ */

import { spawn } from 'node:child_process';

const BASE = process.argv[2];
if (!BASE) {
  console.error('usage: node scripts/check-live.mjs <url>');
  process.exit(2);
}

const port = 9700 + Math.floor(Math.random() * 90);
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${process.env.TEMP}\\ir-live-${Date.now()}`,
    'about:blank'
  ],
  { stdio: 'ignore' }
);

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
const consoleErrors = [];
const apiCalls = [];
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
    return;
  }
  if (msg.method === 'Runtime.exceptionThrown') consoleErrors.push(msg.params?.exceptionDetails?.text || 'exception');
  if (msg.method === 'Log.entryAdded' && msg.params?.entry?.level === 'error') consoleErrors.push(msg.params.entry.text);
  if (msg.method === 'Network.requestWillBeSent' && /\/api\//.test(msg.params?.request?.url || '')) {
    apiCalls.push(msg.params.request.url);
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
await send('Network.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 430, height: 932, deviceScaleFactor: 2, mobile: true });
await send('Page.navigate', { url: BASE });
await sleep(3000);

check('page loads', (await evaluate('document.title')).includes('آنتن'));
check('static build flag is on', (await evaluate('window.__STATIC === true')) === true);
check('shell rendered 8 operators', (await evaluate(`document.querySelectorAll('.op-card').length`)) === 8);
check('no api calls', apiCalls.length === 0, apiCalls.join(' '));

await evaluate('document.fonts.ready.then(() => true)');
const fontOk = await evaluate(`[...document.fonts].some((f) => f.family.includes('Vazirmatn'))`);
check('Vazirmatn is loaded from the page', fontOk === true);

await evaluate('window.__blobs = 0; window.__lastBlob = null; const orig = URL.createObjectURL; URL.createObjectURL = (b) => { window.__blobs += 1; window.__lastBlob = b; return orig(b); };');
await evaluate(`document.querySelector('[data-op="mci"]').click()`);
await sleep(250);
await evaluate(`document.getElementById('buildBtn').click()`);
await sleep(1200);

const title = await evaluate(`document.getElementById('sheetTitle').textContent`);
check('build opens the install sheet', (await evaluate(`document.getElementById('sheet').hidden === false`)) === true, title);
check('a file was produced', (await evaluate('window.__blobs')) >= 1);
const fileText = await evaluate(`window.__lastBlob ? window.__lastBlob.text() : ''`);
check('file is a cellular profile', /com\.apple\.cellular/.test(fileText) && /<key>APNs</.test(fileText));
check('history recorded the build', (await evaluate(`(JSON.parse(localStorage.getItem('ir.history.v1')) || []).length`)) >= 1);

// the credit lives on the about tab, so the tab has to be opened before asserting it
await evaluate(`document.querySelector('[data-tab="about"]').click()`);
await sleep(400);
check('credits the channel', (await evaluate(`Boolean(document.querySelector('a[href="https://t.me/AmyraxVPN"]'))`)));
check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));

ws.close();
chrome.kill();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
