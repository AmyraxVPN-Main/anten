/* language: JavaScript (ES2022) | file: scripts/build-site.mjs | runtime: Node 20+
   static export for GitHub Pages: the same app with every server call removed, so a profile is
   built in the browser. Run before deploy; output goes to site/. */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'site');
const PUBLIC = path.join(ROOT, 'public');
const SHARED = path.join(ROOT, 'shared');

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

function copyDir(from, to, skip = () => false) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    if (skip(entry.name)) continue;
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dest, skip);
    else fs.copyFileSync(src, dest);
  }
}

copyDir(PUBLIC, OUT);

// shared sources ride along so the browser can import the real builder instead of a copy
copyDir(SHARED, path.join(OUT, 'shared'));

const indexFile = path.join(OUT, 'index.html');
let html = fs.readFileSync(indexFile, 'utf8');

const appHash = createHash('sha1').update(fs.readFileSync(path.join(PUBLIC, 'app.js'))).digest('hex').slice(0, 8);
const cssHash = createHash('sha1').update(fs.readFileSync(path.join(PUBLIC, 'styles.css'))).digest('hex').slice(0, 8);
const buildHash = createHash('sha256').update(appHash + cssHash + fs.readFileSync(path.join(PUBLIC, 'sw.js')) + fs.readdirSync(SHARED).sort().map((file) => fs.readFileSync(path.join(SHARED, file))).join('')).digest('hex').slice(0, 12);

html = html
  .replaceAll('/styles.css?v=__BUILD__', `./styles.css?v=${cssHash}`)
  .replaceAll('/app.js?v=__BUILD__', `./app.js?v=${buildHash}`)
  .replaceAll('href="/icon.svg"', 'href="./icon.svg"')
  .replaceAll('href="/icon-512.png"', 'href="./icon-512.png"')
  .replaceAll('href="/fonts/Vazirmatn.woff2"', 'href="./fonts/Vazirmatn.woff2"')
  .replaceAll('href="/manifest.webmanifest"', 'href="./manifest.webmanifest"')
  .replace(
    '<script type="module"',
    '<script>window.__STATIC = true;</script>\n  <script type="module"'
  );

fs.writeFileSync(indexFile, html, 'utf8');

const appFile = path.join(OUT, 'app.js');
let app = fs.readFileSync(appFile, 'utf8');
app = app
  .replaceAll("from '/shared/profile.js?v=__BUILD__'", `from './shared/profile.js?v=${buildHash}'`)
  .replaceAll("from '/shared/catalog.js?v=__BUILD__'", `from './shared/catalog.js?v=${buildHash}'`);
fs.writeFileSync(appFile, app, 'utf8');
const workerFile = path.join(OUT, 'sw.js');
fs.writeFileSync(workerFile, fs.readFileSync(workerFile, 'utf8').replace("'ir-v11'", `'ir-static-${buildHash}'`));

// relative manifest so the app installs from any repository path
const manifestFile = path.join(OUT, 'manifest.webmanifest');
if (fs.existsSync(manifestFile)) {
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  manifest.start_url = './';
  manifest.scope = './';
  for (const icon of manifest.icons || []) {
    if (icon.src.startsWith('/')) icon.src = `.${icon.src}`;
  }
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2), 'utf8');
}

const css = fs.readFileSync(path.join(OUT, 'styles.css'), 'utf8');
// absolute asset urls break on a project page: rewrite quoted and bare forms alike
const scopedCss = css.replace(/url\((['"]?)\//g, 'url($1./');
fs.writeFileSync(path.join(OUT, 'styles.css'), scopedCss, 'utf8');

// pages needs a marker, and a nojekyll keeps underscored names safe
fs.writeFileSync(path.join(OUT, '.nojekyll'), '', 'utf8');

console.log(`site built: ${fs.readdirSync(OUT).length} entries`);
