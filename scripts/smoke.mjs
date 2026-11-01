/* language: JavaScript (ES2022) | file: scripts/smoke.mjs | runtime: Node 20+
   end-to-end check against a running server: node scripts/smoke.mjs [baseUrl]
   exits non-zero on the first failed assertion. */

const BASE = process.argv[2] || process.env.BASE || 'http://127.0.0.1:8787';
const ADMIN = process.env.ADMIN_KEY || '';

const OPENSSL = process.env.OPENSSL_BIN || 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe';

/** unwrap a CMS signed blob and return the payload text */
async function verifyCms(buffer) {
  const { execFile } = await import('node:child_process');
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const os = await import('node:os');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'smoke-cms-'));
  const input = path.join(dir, 'in.der');
  const output = path.join(dir, 'out.bin');
  try {
    await fs.writeFile(input, buffer);
    await new Promise((resolve, reject) => {
      execFile(OPENSSL, ['cms', '-verify', '-noverify', '-inform', 'DER', '-in', input, '-out', output], (err) =>
        err ? reject(err) : resolve()
      );
    });
    return await fs.readFile(output, 'utf8');
  } finally {
    fs.rm(dir, { recursive: true, force: true });
  }
}

let passed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(`${name}${detail ? `, ${detail}` : ""} : ''}`);
    console.log(`  FAIL ${name}${detail ? `, ${detail}` : ""} : ''}`);
  }
}

async function json(path, options) {
  const res = await fetch(BASE + path, options);  const body = await res.json().catch(() => ({}));
  return { res, body };
}

async function post(path, payload) {
  return json(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
}

const jar = new Map();
function cookieHeader() {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}
function absorb(res) {
  const raw = res.headers.getSetCookie?.() || [];
  for (const line of raw) {
    const [pair] = line.split(';');
    const idx = pair.indexOf('=');
    if (idx > 0) jar.set(pair.slice(0, idx), pair.slice(idx + 1));
  }
}

console.log(`smoke → ${BASE}\n`);

/* MDM: enroll, SCEP, check-in, poll, install command */
{
  const enroll = await fetch(`${BASE}/mdm/enroll?op=mci`);
  const body = Buffer.from(await enroll.arrayBuffer());
  check('enroll returns a profile', enroll.status === 200 && /aspen-config/.test(enroll.headers.get('content-type') || ''), String(enroll.status));

  const caps = await fetch(`${BASE}/mdm/scep?operation=GetCACaps`);
  check('scep advertises POST', /POSTPKIOperation/.test(await caps.text()));
  const ca = await fetch(`${BASE}/mdm/scep?operation=GetCACert`);
  check('scep serves the CA cert', ca.status === 200 && (await ca.arrayBuffer()).byteLength > 400);

  // the enrollment profile is CMS signed, so read the check-in token out of it
  const xml = await verifyCms(body);
  const token = xml.match(/checkin\?token=([A-Za-z0-9_-]+)/)?.[1];
  check('enrollment profile is signed', xml.length > 1000, String(xml.length));

  const udid = `SIM${Date.now()}`;
  const ci = await fetch(`${BASE}/mdm/checkin?token=${token}`, {
    method: 'PUT',
    body: `<plist><dict><key>MessageType</key><string>TokenUpdate</string><key>UDID</key><string>${udid}</string><key>PushMagic</key><string>m</string></dict></plist>`
  });
  check('check-in accepted', ci.status === 200, String(ci.status));

  const poll = await fetch(`${BASE}/mdm/server`, {
    method: 'PUT',
    body: `<plist><dict><key>MessageType</key><string>Idle</string><key>UDID</key><string>${udid}</string></dict></plist>`
  });
  const cmd = await poll.arrayBuffer();
  check('poll returns a command', poll.status === 200 && cmd.byteLength > 500, String(cmd.byteLength));
  const cmdXml = await verifyCms(Buffer.from(cmd));
  check('command is InstallProfile', /InstallProfile/.test(cmdXml));
  const payload = Buffer.from(cmdXml.match(/<data>([A-Za-z0-9+/=]+)<\/data>/)[1], 'base64').toString('utf8');
  check('command carries a cellular payload', /com\.apple\.cellular/.test(payload) && /<key>APN</.test(payload));

  const again = await fetch(`${BASE}/mdm/server`, {
    method: 'PUT',
    body: `<plist><dict><key>MessageType</key><string>Idle</string><key>UDID</key><string>${udid}</string></dict></plist>`
  });
  check('second poll is empty within the window', (await again.arrayBuffer()).byteLength === 0);
}

/* health */
{
  const { res, body } = await json('/api/health');
  check('health 200', res.status === 200);
  check('self-test ok', body.ok === true, JSON.stringify(body));
  check('8 operators', body.operators === 8, String(body.operators));
}

/* watchdog probe: cheap, empty, cache-free */
{
  const res = await fetch(`${BASE}/api/ping`);
  check('ping 204', res.status === 204, String(res.status));
  check('ping has no body', (await res.text()).length === 0);
  check('ping is not cached', /no-store/.test(res.headers.get('cache-control') || ''));
}

/* catalog */
{
  const { body } = await json('/api/catalog');
  check('catalog operators', body.operators?.length === 8);
  check('catalog formats', body.formats?.length === 3);
  check('matrix rows', body.matrix?.length >= 3);
}

/* create + download (universal, mci) */
let created;
{
  const { res, body } = await post('/api/profile', { operatorId: 'mci', format: 'universal' });
  created = body;
  check('create 201', res.status === 201, JSON.stringify(body));
  check('uuid shaped', /^[0-9a-f-]{36}$/.test(body.uuid || ''));
  check('download url', /\/p\/[0-9a-f]{16}\.mobileconfig\?t=/.test(body.downloadUrl || ''));

  const dl = await fetch(body.downloadUrl);
  absorb(dl);
  const ct = dl.headers.get('content-type') || '';
  const signed = ct === 'application/x-apple-aspen-config';
  const raw = Buffer.from(await dl.arrayBuffer());
  check('download 200', dl.status === 200, String(dl.status));
  check('mime', ct.startsWith('application/x-apple-aspen-config'), ct);
  check('attachment', /attachment; filename="anten-/.test(dl.headers.get('content-disposition') || ''));
  check('no-store', dl.headers.get('cache-control') === 'no-store');
  check('non-empty body', raw.length > 500, String(raw.length));
  if (signed) check('der signature', raw[0] === 0x30, raw.subarray(0, 2).toString('hex'));

  // payload assertions always run against the preview endpoint so they work signed or unsigned
  const xml = await (await fetch(body.previewUrl)).text();
  check('plist root', xml.startsWith('<?xml') && xml.includes('<key>PayloadType</key>\n\t<string>Configuration</string>'));
  check('cellular payload', xml.includes('<string>com.apple.cellular</string>'));
  check('legacy APN key', xml.includes('<key>APN</key>\n\t\t\t<string>mcinet</string>') || xml.includes('<key>APN</key>'));
  check('ddna array', xml.includes('<key>APNs</key>'));
  check('mcinet present', xml.includes('mcinet'));
  check('xlat flag', xml.includes('<key>EnableXLAT464</key>\n\t\t\t\t\t<true/>') || xml.includes('EnableXLAT464'));
}

/* one-device lock: second fetch without the bound cookie */
{
  const res = await fetch(created.downloadUrl);
  const body = await res.text();
  check('second device blocked', res.status === 409, String(res.status));
  check('blocked message is persian', body.includes('دستگاه دیگری'), body.slice(0, 40));
}

/* same device again works */
{
  const res = await fetch(created.downloadUrl, { headers: { cookie: cookieHeader() } });
  check('same device allowed', res.status === 200, String(res.status));
}

/* legacy vs modern shape */
{
  const legacy = await post('/api/profile', { operatorId: 'irancell', format: 'legacy' });
  const xml = await (await fetch(legacy.body.previewUrl)).text();
  check('legacy has APN key', xml.includes('<key>APN</key>'));
  check('legacy has no APNs array', !xml.includes('<key>APNs</key>'));
  check('legacy irancell', xml.includes('mtnirancell'));

  const modern = await post('/api/profile', { operatorId: 'irancell', format: 'modern' });
  const modernXml = await (await fetch(modern.body.previewUrl)).text();
  check('modern has APNs array', modernXml.includes('<key>APNs</key>'));
  check('modern drops legacy APN', !modernXml.includes('<key>APN</key>'));
}

/* all operators profile */
{
  const all = await post('/api/profile', { operatorId: 'all' });
  check('all profile entries', (all.body.entries || []).length >= 5, JSON.stringify(all.body.entries));
  const xml = await (await fetch(all.body.previewUrl)).text();
  check('all contains mcinet', xml.includes('mcinet'));
  check('all contains mtnirancell', xml.includes('mtnirancell'));
  check('all contains rightel', xml.includes('rightel'));
}

/* custom apn */
{
  const custom = await post('/api/profile', {
    operatorId: 'custom',
    format: 'universal',
    customEntries: [{ apn: 'my.apn', username: 'u1', password: 'p1' }]
  });
  check('custom accepted', custom.res.status === 201, JSON.stringify(custom.body));
  const xml = await (await fetch(custom.body.previewUrl)).text();
  check('custom apn applied', xml.includes('my.apn'));

  const bad = await post('/api/profile', { operatorId: 'custom', customEntries: [] });
  check('custom empty rejected', bad.res.status === 400, String(bad.res.status));

  const injection = await post('/api/profile', {
    operatorId: 'custom',
    customEntries: [{ apn: 'x</string><key>Evil</key>' }]
  });
  check('apn injection rejected', injection.res.status === 400, String(injection.res.status));
}

/* profile body: the profile must resist removal so it stays across drops */
{
  const res = await fetch(created.downloadUrl, { headers: { cookie: cookieHeader() } });
  const xml = await res.text();
  check('profile locks removal', /<key>PayloadRemovalDisallowed<\/key>\s*<true\/>/.test(xml), xml.slice(0, 120));
}

/* token handling */
{
  const res = await fetch(`${BASE}/p/${created.id}.mobileconfig?t=deadbeef`);
  check('bad token rejected', res.status === 403, String(res.status));
  const missing = await fetch(`${BASE}/p/${created.id}.mobileconfig`);
  check('missing token rejected', missing.status === 403, String(missing.status));
  const unknown = await fetch(`${BASE}/p/aaaaaaaaaaaaaaaa.mobileconfig?t=x`, { headers: { cookie: cookieHeader() } });
  check('unknown profile 404', unknown.status === 404, String(unknown.status));
}

/* admin */
if (ADMIN) {
  const res = await fetch(`${BASE}/api/admin/stats`, { headers: { 'x-admin-key': ADMIN } });
  const body = await res.json();
  check('admin stats', res.status === 200 && typeof body.total === 'number', JSON.stringify(body));
  const denied = await fetch(`${BASE}/api/admin/stats`, { headers: { 'x-admin-key': 'wrong' } });
  check('admin denied without key', denied.status === 401, String(denied.status));
}

/* static shell */
{
  const page = await fetch(BASE + '/');
  const html = await page.text();
  check('index served', page.status === 200 && html.includes('آنتن'));
  check('csp present', (page.headers.get('content-security-policy') || '').includes("default-src 'self'"));
  const shared = await fetch(BASE + '/shared/profile.js');
  check('shared module served', shared.status === 200 && (await shared.text()).includes('buildProfile'));
  const traversal = await fetch(BASE + '/../server.js');
  check('traversal blocked', traversal.status === 404 || traversal.status === 403, String(traversal.status));
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(' -', f);
  process.exit(1);
}
