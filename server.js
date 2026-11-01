/* language: JavaScript (ES2022) | file: server.js | runtime: Node 20+ (no dependencies)
   iRegister: iOS carrier-profile minting service.
   mints a UUID-bound profile per request, serves it as application/x-apple-aspen-config,
   optionally CMS-signs it, and binds the download link to one device cookie. */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, createHmac, createHash, timingSafeEqual } from 'node:crypto';

import { PUBLIC_DIR, SHARED_DIR, config } from './src/config.js';
import { createRecord, getRecord, updateRecord, listRecords, stats } from './src/ledger.js';
import { buildProfile, newUuid, selfTest } from './shared/profile.js';
import { OPERATORS, FORMATS, IOS_MATRIX, verificationOf } from './shared/catalog.js';
import { signProfile, signingAvailable, signingStatus } from './src/sign.js';
import {
  SCEP_CAPS,
  caCertPath,
  checkin as mdmCheckin,
  enrollmentProfile,
  hasCa,
  newToken,
  nextCommand,
  scepIssue,
  tokenInfo
} from './src/mdm.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8'
};

const startedAt = Date.now();
const rateMap = new Map();

/* ---------- build stamp ----------
   the shell references its assets as `?v=__BUILD__`; the stamp is the newest mtime among the files
   that make up the shell. when one of them changes, every url changes with it, so a browser cache
   that was primed before a deploy cannot serve the old copy. */

const BUILD_TOKEN = '__BUILD__';
const BUILD_SOURCES = [
  path.join(PUBLIC_DIR, 'index.html'),
  path.join(PUBLIC_DIR, 'app.js'),
  path.join(PUBLIC_DIR, 'styles.css'),
  path.join(PUBLIC_DIR, 'sw.js'),
  path.join(SHARED_DIR, 'profile.js'),
  path.join(SHARED_DIR, 'catalog.js')
];

let stampCache = { at: 0, stamp: 'dev' };

function buildStamp() {
  const now = Date.now();
  if (now - stampCache.at < 1000) return stampCache.stamp;
  let newest = 0;
  for (const file of BUILD_SOURCES) {
    try {
      newest = Math.max(newest, fs.statSync(file).mtimeMs);
    } catch {
      /* a missing file just does not contribute to the stamp */
    }
  }
  stampCache = { at: now, stamp: newest ? Math.floor(newest).toString(36) : 'dev' };
  return stampCache.stamp;
}

/* ---------- helpers ---------- */

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body)
  });
  res.end(body);
}

function text(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}

function clientIp(req) {
  const trust = process.env.TRUST_PROXY === '1';
  if (trust) {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (xff) return xff;
  }
  return req.socket.remoteAddress || 'unknown';
}

function rateLimited(req) {
  const ip = clientIp(req);
  const now = Date.now();
  const entry = rateMap.get(ip);
  if (!entry || now > entry.reset) {
    rateMap.set(ip, { count: 1, reset: now + config.rateLimitWindowMs });
    return false;
  }
  entry.count += 1;
  return entry.count > config.rateLimitMax;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateMap) if (now > entry.reset) rateMap.delete(ip);
}, 60_000).unref();

function readBody(req, limit = 64 * 1024, asText = false) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve(asText ? '' : {});
      if (asText) return resolve(Buffer.concat(chunks).toString('utf8'));
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('invalid json'));
      }
    });
    req.on('error', reject);
  });
}

function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    if (!key) continue;
    out[key] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function deviceHash(raw) {
  return createHash('sha256').update(`${raw}:${config.secret}`).digest('hex').slice(0, 32);
}

function signToken(id, exp) {
  return createHmac('sha256', config.secret).update(`${id}:${exp}`).digest('base64url');
}

function verifyToken(id, exp, token) {
  const expected = signToken(id, exp);
  const a = Buffer.from(expected);
  const b = Buffer.from(String(token || ''));
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function baseUrl(req) {
  if (config.baseUrl) return config.baseUrl;
  const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  const host = req.headers.host || `localhost:${config.port}`;
  return `${proto}://${host}`;
}

function makeId() {
  return randomBytes(8).toString('hex');
}

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'permissions-policy': 'geolocation=(), microphone=(), camera=()'
};

/* ---------- routes ---------- */

function apiHealth(req, res) {
  const st = selfTest();
  return json(res, 200, {
    ok: st.ok,
    service: 'iregister',
    version: '1.0.0',
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    operators: st.operators,
    signing: signingAvailable(),
    binding: config.bindDevice,
    buildBytes: st.bytes
  });
}

/* cheapest possible probe for the keep-alive watchdog: no body, no self-test */
function apiPing(req, res) {
  res.writeHead(204, { 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
  res.end();
}

function apiCatalog(req, res) {
  return json(res, 200, {
    operators: OPERATORS.map((op) => ({ ...op, verification: verificationOf(op.id) })),
    formats: FORMATS,
    matrix: IOS_MATRIX
  });
}

async function apiCreateProfile(req, res) {
  console.log('PROFILE POST', Date.now());
  if (rateLimited(req)) return json(res, 429, { error: 'تعداد درخواست‌ها زیاد است؛ چند دقیقه بعد تلاش کنید.' });

  const body = await readBody(req);

  // reject nonsense before touching the builder so the error is specific
  if (body.operatorId === 'custom' && !(Array.isArray(body.customEntries) && body.customEntries.some((e) => e?.apn))) {
    return json(res, 400, { error: 'برای «سایر اپراتورها» حداقل یک APN سفارشی وارد کنید.' });
  }

  let built;
  try {
    built = buildProfile(body);
  } catch (err) {
    return json(res, 400, { error: err.message || 'پروفایل ساخته نشد.' });
  }

  const id = makeId();
  const now = Date.now();
  const expiresAt = now + config.tokenTtlMinutes * 60_000;
  const token = signToken(id, expiresAt);

  const record = {
    id,
    uuid: built.uuids.root,
    uuids: built.uuids,
    opts: built.opts,
    operatorId: built.opts.operatorId,
    format: built.opts.format,
    entries: built.opts.entries.map((e) => e.apn),
    createdAt: now,
    expiresAt,
    signed: false,
    device: null,
    hits: 0,
    ip: clientIp(req),
    ua: String(req.headers['user-agent'] || '').slice(0, 180)
  };

  createRecord(record);

  return json(res, 201, {
    id,
    uuid: built.uuids.root,
    entries: record.entries,
    format: record.format,
    expiresAt,
    downloadUrl: `${baseUrl(req)}/p/${id}.mobileconfig?t=${token}`,
    previewUrl: `${baseUrl(req)}/api/profile/${id}/preview?t=${token}`
  });
}

function apiProfileMeta(req, res, id, url) {
  const record = getRecord(id);
  if (!record) return json(res, 404, { error: 'پروفایل پیدا نشد.' });
  const token = url.searchParams.get('t');
  if (!verifyToken(id, record.expiresAt, token)) return json(res, 403, { error: 'توکن نامعتبر است.' });

  return json(res, 200, {
    id: record.id,
    uuid: record.uuid,
    operatorId: record.operatorId,
    format: record.format,
    entries: record.entries,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    signed: record.signed,
    bound: Boolean(record.device),
    hits: record.hits
  });
}

/* ---------- MDM: enrollment, SCEP, check-in, poll ---------- */

async function mdmEnroll(req, res, url) {
  const op = url.searchParams.get('op') || 'mci';
  const operator = OPERATORS.find((o) => o.id === op);
  if (!operator) return text(res, 400, 'unknown operator');

  const token = newToken(operator.id);
  const { xml } = enrollmentProfile({
    token,
    baseUrl: baseUrl(req),
    operatorLabel: operator.fa
  });

  let body = Buffer.from(xml, 'utf8');
  let type = 'application/x-apple-aspen-config';
  if (signingAvailable()) {
    try {
      body = await signProfile(`mdm-${token}`, xml);
      type = 'application/x-apple-aspen-config';
    } catch {
      /* unsigned enrollment still installs over HTTPS */
    }
  }

  res.writeHead(200, {
    'content-type': type,
    'content-disposition': 'attachment; filename="anten-guard.mobileconfig"',
    'cache-control': 'no-store'
  });
  res.end(body);
}

async function mdmScep(req, res, url) {
  const operation = (url.searchParams.get('operation') || '').toLowerCase();

  if (operation === 'getcacaps') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(SCEP_CAPS);
  }
  if (operation === 'getcacert') {
    if (!hasCa()) return text(res, 500, 'no CA');
    const der = await fs.promises.readFile(caCertPath());
    res.writeHead(200, { 'content-type': 'application/x-x509-ca-cert', 'cache-control': 'no-store' });
    return res.end(der);
  }
  if (operation === 'pkioperation') {
    try {
      const raw = await readBody(req, 1024 * 1024, true);
      const der = await scepIssue(raw.replace(/\s+/g, ''));
      res.writeHead(200, { 'content-type': 'application/x-pki-message', 'cache-control': 'no-store' });
      return res.end(der);
    } catch (err) {
      return text(res, 500, `scep: ${err.message}`);
    }
  }
  return text(res, 400, 'unknown scep operation');
}

async function mdmCheckinRoute(req, res, url) {
  const xml = await readBody(req, 256 * 1024, true);
  const out = await mdmCheckin(String(xml), url.searchParams.get('token') || '');
  res.writeHead(200, { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'no-store' });
  res.end(out.ok ? '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict/></plist>' : '');
}

async function mdmServerRoute(req, res) {
  const xml = await readBody(req, 256 * 1024, true);
  const udid = String(xml).match(/<key>UDID<\/key>\s*<string>([^<]+)<\/string>/)?.[1];
  if (!udid) return text(res, 400, 'no udid');

  const command = await nextCommand(udid);
  if (!command) {
    res.writeHead(200, { 'cache-control': 'no-store' });
    return res.end();
  }
  res.writeHead(200, { 'content-type': 'application/x-apple-aspen-mdm', 'cache-control': 'no-store' });
  res.end(command);
}

async function apiPreview(req, res, id, url) {
  const record = getRecord(id);
  if (!record) return text(res, 404, 'not found');
  if (!verifyToken(id, record.expiresAt, url.searchParams.get('t'))) return text(res, 403, 'forbidden');

  const { xml } = buildProfile({ ...record.opts, uuids: record.uuids });
  res.writeHead(200, { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'no-store' });
  res.end(xml);
}

async function serveProfile(req, res, id, url) {
  const record = getRecord(id);
  if (!record) return text(res, 404, 'پروفایل پیدا نشد.');

  if (Date.now() > record.expiresAt) {
    return text(res, 410, 'این لینک منقضی شده است. پروفایل تازه بسازید.');
  }
  if (!verifyToken(id, record.expiresAt, url.searchParams.get('t'))) {
    return text(res, 403, 'توکن دانلود نامعتبر است.');
  }
  if (record.device && config.bindDevice) {
    const cookies = parseCookies(req.headers.cookie);
    const current = cookies.ir_dev ? deviceHash(cookies.ir_dev) : '';
    if (current !== record.device.hash) {
      return text(
        res,
        409,
        'این پروفایل قبلاً روی دستگاه دیگری فعال شده است. برای هر گوشی یک پروفایل تازه بسازید.',
        'text/plain; charset=utf-8'
      );
    }
  }

  const headers = { ...SECURITY_HEADERS, 'cache-control': 'no-store' };

  const cookies = parseCookies(req.headers.cookie);
  let device = cookies.ir_dev;
  if (!device) {
    device = randomBytes(16).toString('hex');
    headers['set-cookie'] = `ir_dev=${device}; Path=/; HttpOnly; SameSite=Lax; Max-Age=34560000`;
  }

  if (!record.device && config.bindDevice) {
    updateRecord(id, {
      device: { hash: deviceHash(device), at: Date.now(), ip: clientIp(req), ua: String(req.headers['user-agent'] || '').slice(0, 180) }
    });
  }
  updateRecord(id, { hits: (record.hits || 0) + 1, lastHit: Date.now() });

  const { xml } = buildProfile({ ...record.opts, uuids: record.uuids });
  let body = Buffer.from(xml, 'utf8');
  let type = 'application/x-apple-aspen-config; charset=utf-8';

  if (config.bindDevice && !record.device) {
    // bound on this response; nothing else to do
  }

  if (signingAvailable()) {
    try {
      body = await signProfile(id, xml);
      type = 'application/x-apple-aspen-config';
      if (!record.signed) updateRecord(id, { signed: true });
    } catch {
      /* keep the unsigned profile rather than failing the download */
    }
  }

  res.writeHead(200, {
    ...headers,
    'content-type': type,
    'content-disposition': `attachment; filename="anten-${id}.mobileconfig"`,
    'content-length': body.length
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

async function apiClaim(req, res, id) {
  const record = getRecord(id);
  if (!record) return json(res, 404, { error: 'پروفایل پیدا نشد.' });
  const cookies = parseCookies(req.headers.cookie);
  const current = cookies.ir_dev ? deviceHash(cookies.ir_dev) : '';
  const claimed = Boolean(record.device) && record.device.hash === current;
  return json(res, 200, { claimed, bound: Boolean(record.device) });
}

function apiAdmin(req, res, url) {
  if (!config.adminKey) return json(res, 404, { error: 'not found' });
  const given = String(req.headers['x-admin-key'] || '');
  if (given.length !== config.adminKey.length || !timingSafeEqual(Buffer.from(given), Buffer.from(config.adminKey))) {
    return json(res, 401, { error: 'unauthorized' });
  }
  if (url.pathname === '/api/admin/stats') return json(res, 200, stats());
  return json(res, 200, { records: listRecords(200) });
}

async function apiAdminAction(req, res, url) {
  if (!config.adminKey) return json(res, 404, { error: 'not found' });
  const given = String(req.headers['x-admin-key'] || '');
  if (!given || given.length !== config.adminKey.length || !timingSafeEqual(Buffer.from(given), Buffer.from(config.adminKey))) {
    return json(res, 401, { error: 'unauthorized' });
  }
  if (url.pathname === '/api/admin/rebind') {
    const body = await readBody(req);
    if (!body.id) return json(res, 400, { error: 'id required' });
    const updated = updateRecord(body.id, { device: null, hits: 0 });
    return json(res, updated ? 200 : 404, updated ? { ok: true, id: body.id } : { error: 'not found' });
  }
  return json(res, 404, { error: 'not found' });
}

/* ---------- static ---------- */

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';

  const [root, prefix] = rel.startsWith('/shared/') ? [SHARED_DIR, '/shared'] : [PUBLIC_DIR, ''];
  const target = path.resolve(path.join(root, rel.slice(prefix.length)));
  const rootResolved = path.resolve(root) + path.sep;
  if (!target.startsWith(rootResolved)) return text(res, 403, 'forbidden');

  fs.stat(target, (err, stat) => {
    if (err || !stat.isFile()) {
      if (rel.startsWith('/api/')) return json(res, 404, { error: 'not found' });
      return text(res, 404, 'not found');
    }
    const ext = path.extname(target).toLowerCase();
    // shell files revalidate every load: a deploy must reach the phone without a manual cache clear.
    const revalidate = ext === '.html' || ext === '.js' || ext === '.css' || ext === '.webmanifest';
    const headers = {
      ...SECURITY_HEADERS,
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': revalidate ? 'no-cache' : 'public, max-age=86400',
      'content-length': stat.size
    };
    if (ext === '.html') {
      headers['content-security-policy'] =
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
        "font-src 'self' data:; img-src 'self' data:; connect-src 'self'; " +
        "frame-ancestors 'none'; base-uri 'self'; form-action 'self'";
    }
    if (ext === '.html' || ext === '.js') {
      // swap the build placeholder for a stamp derived from file mtimes, so a changed asset gets a
      // new url and can never be served from a stale browser cache
      fs.readFile(target, 'utf8', (readErr, body) => {
        if (readErr) return text(res, 500, 'read failed');
        const payload = Buffer.from(body.replaceAll(BUILD_TOKEN, buildStamp()), 'utf8');
        headers['content-length'] = payload.length;
        res.writeHead(200, headers);
        if (req.method === 'HEAD') return res.end();
        res.end(payload);
      });
      return;
    }
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(target).pipe(res);
  });
}

/* ---------- server ---------- */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const method = req.method || 'GET';

  try {
    if (url.pathname === '/api/health') return apiHealth(req, res);
    if (url.pathname === '/api/ping') return apiPing(req, res);
    if (url.pathname === '/api/catalog') return apiCatalog(req, res);

    if (url.pathname === '/mdm/enroll') return await mdmEnroll(req, res, url);
    if (url.pathname === '/mdm/scep') return await mdmScep(req, res, url);
    if (url.pathname === '/mdm/checkin' && method === 'PUT') return await mdmCheckinRoute(req, res, url);
    if (url.pathname === '/mdm/server' && method === 'PUT') return await mdmServerRoute(req, res);

    if (url.pathname === '/api/profile' && method === 'POST') return await apiCreateProfile(req, res);
    if (url.pathname === '/api/admin/stats') return apiAdmin(req, res, url);
    if (url.pathname === '/api/admin/ledger') return apiAdmin(req, res, url);
    if (url.pathname === '/api/admin/rebind' && method === 'POST') return await apiAdminAction(req, res, url);

    const profileMatch = url.pathname.match(/^\/p\/([a-f0-9]{16})\.mobileconfig$/);
    if (profileMatch) return await serveProfile(req, res, profileMatch[1], url);

    const metaMatch = url.pathname.match(/^\/api\/profile\/([a-f0-9]{16})$/);
    if (metaMatch) return apiProfileMeta(req, res, metaMatch[1], url);

    const previewMatch = url.pathname.match(/^\/api\/profile\/([a-f0-9]{16})\/preview$/);
    if (previewMatch) return await apiPreview(req, res, previewMatch[1], url);

    const claimMatch = url.pathname.match(/^\/api\/profile\/([a-f0-9]{16})\/claim$/);
    if (claimMatch && method === 'POST') return await apiClaim(req, res, claimMatch[1]);

    if (url.pathname.startsWith('/api/')) return json(res, 404, { error: 'not found' });

    return serveStatic(req, res, url);
  } catch (err) {
    if (String(err.message).includes('body too large')) return json(res, 413, { error: 'payload too large' });
    if (String(err.message).includes('invalid json')) return json(res, 400, { error: 'invalid json' });
    console.error('[error]', url.pathname, err);
    return json(res, 500, { error: 'internal error' });
  }
});

server.listen(config.port, config.host, () => {
  const st = selfTest();
  console.log(`iRegister listening on http://${config.host}:${config.port}`);
  console.log(`  build self-test : ${st.ok ? 'ok' : 'FAILED'} (${st.bytes} bytes)`);
  console.log(`  signing         : ${signingAvailable() ? 'on' : 'off (unsigned profiles still install)'}`);
  console.log(`  device binding  : ${config.bindDevice ? 'on' : 'off'}`);
  console.log(`  admin api       : ${config.adminKey ? 'enabled' : 'disabled'}`);
  if (!config.baseUrl) console.log('  tip             : set PUBLIC_BASE_URL when behind a reverse proxy');
});

export { server };
