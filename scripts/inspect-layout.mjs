/* language: JavaScript (ES2022) | file: scripts/inspect-layout.mjs | runtime: Node 22+ (global WebSocket)
   dev tool: launches headless chrome, measures the page, reports elements wider than the viewport.
   usage: node scripts/inspect-layout.mjs http://127.0.0.1:8787/ 430 */

import { spawn } from 'node:child_process';

const url = process.argv[2] || 'http://127.0.0.1:8787/';
const width = Number(process.argv[3] || 430);
const port = 9333;
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--hide-scrollbars',
    `--remote-debugging-port=${port}`,
    `--window-size=${width},900`,
    `--user-data-dir=${process.env.TEMP}\\ir-inspect-${Date.now()}`,
    url
  ],
  { stdio: 'ignore', detached: false }
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function target() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error('devtools target not available');
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

function send(method, params = {}) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve) => pending.set(id, resolve));
}

await send('Page.enable');
await send('Runtime.enable');
await sleep(1200);

const expr = `(() => {
  const vw = document.documentElement.clientWidth;
  const out = { vw, scrollWidth: document.documentElement.scrollWidth, bodyScroll: document.body.scrollWidth, scrollLeft: document.documentElement.scrollLeft, bodyScrollLeft: document.body.scrollLeft, culprits: [] };
  const all = document.querySelectorAll('body *');
  for (const el of all) {
    const r = el.getBoundingClientRect();
    if (r.width > vw + 1 || r.right > vw + 1 || r.left < -1) {
      out.culprits.push({ tag: el.tagName, cls: el.className && String(el.className).slice(0, 40), w: Math.round(r.width), left: Math.round(r.left), right: Math.round(r.right) });
    }
  }
  out.culprits = out.culprits.slice(0, 25);
  return JSON.stringify(out);
})()`;

const result = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
console.log(result.result?.result?.value || JSON.stringify(result));

ws.close();
chrome.kill();
process.exit(0);
