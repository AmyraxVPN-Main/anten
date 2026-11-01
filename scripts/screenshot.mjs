/* language: JavaScript (ES2022) | file: scripts/screenshot.mjs | runtime: Node 22+
   dev tool: real mobile-viewport screenshots through CDP (chrome's --window-size floors at 500px).
   usage: node scripts/screenshot.mjs <url> <out.png> [width] [height] [full] */

import { spawn } from 'node:child_process';
import fs from 'node:fs';

const url = process.argv[2] || 'http://127.0.0.1:8787/';
const out = process.argv[3] || 'shot.png';
const width = Number(process.argv[4] || 430);
const height = Number(process.argv[5] || 932);
const full = process.argv[6] === 'full';
const scale = Number(process.argv[7] || 2);
const clickSelector = process.argv[8] || '';
const port = 9334 + Math.floor(Math.random() * 200);
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--hide-scrollbars',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${process.env.TEMP}\\ir-shot-${Date.now()}`,
    'about:blank'
  ],
  { stdio: 'ignore' }
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function target() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      /* retry */
    }
    await sleep(250);
  }
  throw new Error('devtools not ready');
}

const page = await target();
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});

let seq = 0;
const pending = new Map();
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
};
const send = (method, params = {}) => {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve) => pending.set(id, resolve));
};

await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', {
  width,
  height,
  deviceScaleFactor: scale,
  mobile: true,
  screenWidth: width,
  screenHeight: height
});
await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await send('Page.navigate', { url });
await sleep(2200);

if (clickSelector) {
  // comma separated selectors click in order, so a flow like "open panel, open menu" is one run
  for (const part of clickSelector.split(',').map((s) => s.trim()).filter(Boolean)) {
    await send('Runtime.evaluate', {
      expression: `(() => { const el = document.querySelector(${JSON.stringify(part)}); if (el) el.click(); return Boolean(el); })()`,
      returnByValue: true
    });
    await sleep(450);
  }
  await sleep(600);
}

let clip;
if (full) {
  const metrics = await send('Page.getLayoutMetrics');
  const h = Math.ceil(metrics.result.cssContentSize?.height || height);
  clip = { x: 0, y: 0, width, height: h, scale: 1 };
}

const shot = await send('Page.captureScreenshot', {
  format: 'png',
  captureBeyondViewport: full,
  ...(clip ? { clip } : {})
});

if (!shot.result?.data) {
  console.error('capture failed', JSON.stringify(shot).slice(0, 300));
  process.exit(1);
}

fs.writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
console.log(`wrote ${out} (${width}x${full ? 'full' : height})`);

ws.close();
chrome.kill();
process.exit(0);
