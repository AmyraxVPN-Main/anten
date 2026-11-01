/* language: JavaScript (ES2022) | file: scripts/check-static.mjs | runtime: Node 22+
   gate for the GitHub Pages build: the site must mint a profile with no server at all.
   usage: node scripts/check-static.mjs [siteDir] */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';

const DIR = path.resolve(process.argv[2] || 'site');
const PORT = 9400 + Math.floor(Math.random() * 90);
const CHROME = process.env.CHROME_BIN || (process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : '/usr/bin/google-chrome');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2'
};

const server = http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (!pathname.startsWith('/anten/')) { res.writeHead(404); return res.end(); }
  const rel = pathname.slice('/anten'.length);
  const file = path.join(DIR, rel === '/' ? 'index.html' : rel);
  if (!file.startsWith(DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    return res.end('missing');
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const port = PORT + 100;
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${fs.mkdtempSync(path.join(os.tmpdir(), 'ir-static-'))}`,
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
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/anten/` });
await sleep(2200);

check('shell renders', (await evaluate('document.title')).includes('آنتن'));
check('static flag is on', (await evaluate('window.__STATIC === true')) === true);
check('8 operator cells', (await evaluate(`document.querySelectorAll('.op-card').length`)) === 8);
check('no api calls on load', apiCalls.length === 0, apiCalls.join(' '));

// asset paths must survive the repo prefix, the font is the easiest one to break
await evaluate('document.fonts.ready.then(() => true)');
const fontOk = await evaluate(`(async () => {
  const res = await fetch('./fonts/Vazirmatn.woff2');
  const face = [...document.fonts].some((f) => f.family.includes('Vazirmatn'));
  return res.ok && face;
})()`);
check('font loads from the page prefix', fontOk === true);

// count blob urls: that is how the file leaves the browser without a server
await evaluate('window.__blobs = 0; const orig = URL.createObjectURL; URL.createObjectURL = (b) => { window.__blobs += 1; window.__lastBlob = b; return orig(b); };');

await evaluate(`document.querySelector('[data-op="mci"]').click()`);
await sleep(200);
await evaluate(`document.getElementById('buildBtn').click()`);
await sleep(900);

const sheetOpen = await evaluate(`document.getElementById('sheet').hidden === false`);
const title = await evaluate(`document.getElementById('sheetTitle').textContent`);
check('build opens the install sheet', sheetOpen === true, title);
check('file is produced as a blob', (await evaluate('window.__blobs')) >= 1);
const fileText = await evaluate('window.__lastBlob ? window.__lastBlob.text() : \'\'');
check('file is a cellular profile', /com\.apple\.cellular/.test(fileText) && /<key>APNs</.test(fileText));
check('history records the build', (await evaluate(`(JSON.parse(localStorage.getItem('ir.history.v1')) || []).length`)) >= 1);
await evaluate(`document.querySelector('[data-act="report-up"]').click()`);
check('sheet outcome button records the active profile', (await evaluate(`window.__ir.state.drops[0]?.kind === 'up' && window.__ir.state.drops[0]?.profileId === window.__ir.state.history[0].id`)) === true);
await evaluate(`document.querySelector('[data-act="toggle-guard"]').click()`);
await sleep(300);
const readyId = await evaluate(`window.__ir.state.ready.id`);
check('guard keeps durable XML without a blob URL', (await evaluate(`!!window.__ir.state.ready.xml && !window.__ir.state.ready.url`)) === true);
const historyCount = await evaluate(`window.__ir.state.history.length`);
await send('Page.reload');
await sleep(1200);
check('guard and test results survive reload', (await evaluate(`window.__ir.state.guard && window.__ir.state.drops[0]?.kind === 'up'`)) === true);
check('reload reuses the prepared profile', (await evaluate(`window.__ir.state.ready.id === '${readyId}' && window.__ir.state.history.length === ${historyCount}`)) === true);
await evaluate(`document.querySelector('[data-act="install-ready"]').click()`);
check('restored ready profile downloads', (await evaluate(`document.getElementById('sheet').hidden === false && window.__ir.state.history[0].id === '${readyId}'`)) === true);
check('no api calls on build', apiCalls.length === 0, apiCalls.join(' '));
// A cached project page must build even after the network is disabled and the page reloads.
await evaluate(`navigator.serviceWorker.ready.then(() => true)`);
for (let i = 0; i < 30; i++) {
  if (await evaluate(`!!navigator.serviceWorker.controller`)) break;
  await sleep(100);
}
check('worker is scoped to the repository', (await evaluate(`navigator.serviceWorker.controller?.scriptURL.endsWith('/anten/sw.js')`)) === true);
await send('Network.emulateNetworkConditions', {offline:true, latency:0, downloadThroughput:0, uploadThroughput:0});
await send('Page.reload');
await sleep(1500);
check('shell reloads offline', (await evaluate(`!!window.__ir && document.querySelectorAll('.op-card').length === 8`)) === true);
await evaluate(`window.__ir.handleBuild()`);
check('profile builds offline after reload', (await evaluate(`!document.getElementById('sheet').hidden`)) === true);
await send('Network.emulateNetworkConditions', {offline:false, latency:0, downloadThroughput:10000000, uploadThroughput:10000000});
await evaluate(`document.querySelector('.sheet-head .icon-btn').click(); Object.assign(window.__ir.state, {operatorId:'custom', protocol:'ipv4', attach:false, customEntries:[{apn:'test.private', username:'tester', password:'SECRET-NOT-IN-REPORT'}]}); window.__ir.handleBuild()`);
await evaluate(`document.querySelector('[data-act="report-up"]').click()`);
const resultCount = await evaluate(`window.__ir.state.drops.filter(d => d.kind === 'up').length`);
await evaluate(`window.__ir.recordOutcome('up')`);
check('duplicate success does not inflate results', (await evaluate(`window.__ir.state.drops.filter(d => d.kind === 'up').length === ${resultCount}`)) === true);
check('report omits APN credentials', (await evaluate(`!window.__ir.testReport().includes('SECRET-NOT-IN-REPORT') && window.__ir.testReport().includes('test.private')`)) === true);
await send('Page.reload');
await sleep(1200);
check('custom APN and protocol survive reload', (await evaluate(`window.__ir.state.operatorId === 'custom' && window.__ir.state.protocol === 'ipv4' && window.__ir.state.attach === false && window.__ir.state.customEntries[0].password === 'SECRET-NOT-IN-REPORT'`)) === true);
await evaluate(`window.__ir.state.protocol = 'ipv6'; window.__ir.primeGuard()`);
check('guard does not overwrite the form being edited', (await evaluate(`window.__ir.state.protocol === 'ipv6'`)) === true);
await send('Emulation.setDeviceMetricsOverride', {width:360,height:800,deviceScaleFactor:1,mobile:true});
await evaluate(`document.querySelector('.diagnostics').open = true`);
check('diagnostics fits a narrow phone with touch targets', (await evaluate(`document.documentElement.scrollWidth <= innerWidth && [...document.querySelectorAll('.diagnostic-choices button')].every(b => b.getBoundingClientRect().height >= 44)`)) === true);
await evaluate(`document.querySelector('[data-act="reference"][data-value="mci"]').click(); window.__ir.handleBuild()`);
check('MCI reference preset builds with no credentials or attach', (await evaluate(`window.__ir.state.history[0].settings.preset === 'reference' && window.__ir.state.history[0].settings.omitCredentials && !window.__ir.state.history[0].settings.attach && !window.__ir.state.history[0].settings.xlat`)) === true);
await evaluate(`document.querySelector('.sheet-head .icon-btn').click(); document.querySelector('[data-act="reference"][data-value="irancell"]').click(); window.__ir.handleBuild()`);
check('Irancell reference preset builds IPv4 with attach', (await evaluate(`window.__ir.state.history[0].operatorId === 'irancell' && window.__ir.state.history[0].settings.protocol === 'ipv4' && window.__ir.state.history[0].settings.attach && !window.__ir.state.history[0].settings.xlat`)) === true);
await send('Page.reload');
await sleep(1200);
check('reference preset survives reload and recovery', (await evaluate(`window.__ir.state.preset === 'reference' && window.__ir.state.operatorId === 'irancell' && window.__ir.state.protocol === 'ipv4'`)) === true);
await evaluate(`const box = document.querySelector('[data-bind="xlat"]'); box.checked = true; box.dispatchEvent(new Event('change',{bubbles:true}))`);
check('manual editing leaves exact reference mode', (await evaluate(`window.__ir.state.preset === '' && window.__ir.state.xlat === true`)) === true);
check('still no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));

ws.close();
chrome.kill();
server.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
