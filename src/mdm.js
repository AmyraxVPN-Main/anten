/* language: JavaScript (ES2022) | file: src/mdm.js | runtime: Node 20+
   Polling MDM. No APNs certificate needed: the device polls /mdm/server and gets its queued
   InstallProfile command there, so a managed phone can pick up a fresh cellular payload with no
   user action. Commands and the enrollment profile are CMS signed with the same local CA. */

import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { DATA_DIR, config } from './config.js';
import { opensslPath, signingAvailable } from './sign.js';
import { buildProfile } from '../shared/profile.js';

const run = promisify(execFile);
const FILE = path.join(DATA_DIR, 'mdm.json');
const TMP = path.join(DATA_DIR, 'mdm-tmp');
const CA_KEY = path.join(path.dirname(config.signChain), 'ca.key');
fs.mkdirSync(TMP, { recursive: true });

const TOKEN_TTL = 30 * 60_000;
/* how often a managed phone gets a fresh payload; well inside the "one month without touching it" ask */
const PUSH_EVERY = Number(process.env.MDM_PUSH_EVERY_MS || 6 * 60 * 60_000);

let cache = null;

function load() {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    cache = { devices: {}, tokens: {} };
  }
  if (!cache.devices) cache.devices = {};
  if (!cache.tokens) cache.tokens = {};
  return cache;
}

let chain = Promise.resolve();
function save() {
  const db = load();
  chain = chain.then(() => fs.promises.writeFile(FILE, JSON.stringify(db, null, 2), 'utf8')).catch(() => {});
  return chain;
}

const esc = (v) =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');


/* ---------- enrollment ---------- */

export function newToken(operatorId) {
  const token = randomBytes(18).toString('base64url');
  load().tokens[token] = { operatorId, expires: Date.now() + TOKEN_TTL };
  save();
  return token;
}

export function tokenInfo(token) {
  const info = load().tokens[token];
  if (!info || info.expires < Date.now()) return null;
  return info;
}

/** the enrollment profile: SCEP identity, the trusted anchor, and the MDM payload */
export function enrollmentProfile({ token, baseUrl, operatorLabel }) {
  const scepUuid = randomUUID().toUpperCase();
  const mdmUuid = randomUUID().toUpperCase();
  const rootCertUuid = randomUUID().toUpperCase();
  const rootUuid = randomUUID().toUpperCase();
  const url = `${baseUrl}/mdm/scep?token=${encodeURIComponent(token)}`;

  // the device only trusts our TLS chain if the same CA rides inside the profile
  let anchorXml = '';
  if (hasCa()) {
    const der = fs.readFileSync(caCertPath()).toString('base64');
    anchorXml = `<dict>
<key>PayloadType</key><string>com.apple.security.root</string>
<key>PayloadIdentifier</key><string>ir.iregister.root.${rootCertUuid}</string>
<key>PayloadUUID</key><string>${rootCertUuid}</string>
<key>PayloadDisplayName</key><string>ریشه اعتماد iRegister</string>
<key>PayloadVersion</key><integer>1</integer>
<key>PayloadContent</key><data>${der}</data>
</dict>`;
  }

  return {
    scepUuid,
    mdmUuid,
    xml: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>PayloadContent</key>
<array>
${anchorXml}
<dict>
<key>PayloadType</key><string>com.apple.security.scep</string>
<key>PayloadIdentifier</key><string>ir.iregister.scep.${scepUuid}</string>
<key>PayloadUUID</key><string>${scepUuid}</string>
<key>PayloadDisplayName</key><string>هویت دستگاه</string>
<key>PayloadVersion</key><integer>1</integer>
<key>PayloadContent</key><dict>
<key>URL</key><string>${esc(url)}</string>
<key>Name</key><string>iRegister</string>
<key>Subject</key><array><array><key>CN</key><string>iRegister Device</string></array></array>
<key>Challenge</key><string>${esc(token)}</string>
<key>Keysize</key><integer>2048</integer>
<key>Key Type</key><string>RSA</string>
<key>Key Usage</key><integer>5</integer>
</dict>
</dict>
<dict>
<key>PayloadType</key><string>com.apple.mdm</string>
<key>PayloadIdentifier</key><string>ir.iregister.mdm.${mdmUuid}</string>
<key>PayloadUUID</key><string>${mdmUuid}</string>
<key>PayloadDisplayName</key><string>نگهبان ابری آنتن</string>
<key>PayloadVersion</key><integer>1</integer>
<key>IdentityCertificate</key><string>${scepUuid}</string>
<key>ServerURL</key><string>${esc(baseUrl)}/mdm/server</string>
<key>CheckInURL</key><string>${esc(baseUrl)}/mdm/checkin?token=${encodeURIComponent(token)}</string>
<key>CheckOutWhenRemoved</key><true/>
<key>SignMessage</key><true/>${anchorXml ? `\n<key>ServerCertificateAnchorUUID</key><string>${rootCertUuid}</string>` : ''}
<key>Topic</key><string>${esc(baseUrl)}</string>
<key>ServerCapabilities</key><array><string>com.apple.mdm.per-user-connections</string></array>
</dict>
</array>
<key>PayloadIdentifier</key><string>ir.iregister.enroll.${rootUuid}</string>
<key>PayloadUUID</key><string>${rootUuid}</string>
<key>PayloadDisplayName</key><string>${esc(operatorLabel ? `نگهبان آنتن · ${operatorLabel}` : 'نگهبان آنتن')}</string>
<key>PayloadOrganization</key><string>iRegister</string>
<key>PayloadDescription</key><string>دستگاه زیر نگهبان می‌رود تا پروفایل سلولی بدون کار شما تازه شود.</string>
<key>PayloadType</key><string>Configuration</string>
<key>PayloadVersion</key><integer>1</integer>
<key>PayloadRemovalDisallowed</key><true/>
</dict></plist>`
  };
}

/* ---------- SCEP ---------- */

export const SCEP_CAPS = 'POSTPKIOperation\nSHA-256\nAES\nDES3\nSCEPStandard\n';

export function caCertPath() {
  return config.signChain;
}

export function hasCa() {
  return fs.existsSync(config.signChain);
}

/** decode a SCEP PKIOperation and issue a certificate for the CSR inside it */
export async function scepIssue(derBase64) {
  const bin = await opensslPath();
  if (!bin) throw new Error('openssl missing');
  const stamp = `${Date.now()}-${randomBytes(3).toString('hex')}`;
  const req = path.join(TMP, `req-${stamp}.der`);
  const csr = path.join(TMP, `csr-${stamp}.pem`);
  const cert = path.join(TMP, `cert-${stamp}.der`);
  const chainFile = path.join(TMP, `chain-${stamp}.der`);
  const rep = path.join(TMP, `rep-${stamp}.der`);

  try {
    await fs.promises.writeFile(req, Buffer.from(derBase64, 'base64'));
    // the SCEP envelope is CMS signed by the device's temporary self signed key
    const { stdout } = await run(bin, ['cms', '-verify', '-noverify', '-inform', 'DER', '-in', req], {
      timeout: 15_000,
      maxBuffer: 8 * 1024 * 1024,
      encoding: 'buffer'
    });
    await fs.promises.writeFile(csr, stdout);
    await run(
      bin,
      [
        'x509', '-req', '-in', csr,
        '-CA', config.signChain,
        '-CAkey', CA_KEY,
        '-set_serial', String(Date.now()),
        '-days', '365',
        '-outform', 'DER',
        '-out', cert
      ],
      { timeout: 15_000 }
    );
    const leaf = await fs.promises.readFile(cert);
    const ca = await fs.promises.readFile(config.signChain);
    await fs.promises.writeFile(chainFile, Buffer.concat([leaf, ca]));
    await run(
      bin,
      [
        'cms', '-sign', '-binary', '-nodetach', '-in', chainFile,
        '-signer', config.signCert,
        '-inkey', config.signKey,
        '-econtent_type', '2.16.840.1.113733.1.9.3',
        '-outform', 'DER',
        '-out', rep
      ],
      { timeout: 15_000 }
    );
    return await fs.promises.readFile(rep);
  } finally {
    for (const f of [req, csr, cert, chainFile, rep]) fs.promises.rm(f, { force: true }).catch(() => {});
  }
}

/* ---------- check in / poll ---------- */

function plistValue(xml, key) {
  const m = xml.match(new RegExp(`<key>${key}</key>\\s*<(string|data)>([\\s\\S]*?)</\\1>`));
  return m ? m[2].replace(/\s+/g, '') : null;
}

export async function checkin(xml, tokenParam = '') {
  const udid = plistValue(xml, 'UDID');
  if (!udid) return { ok: false };
  const db = load();
  const device = db.devices[udid] || { udid, enrolledAt: Date.now(), pending: [], pushes: 0 };

  const type = plistValue(xml, 'MessageType') || '';
  const magic = plistValue(xml, 'PushMagic');
  if (magic) device.pushMagic = magic;
  const token = plistValue(xml, 'Token');
  if (token) device.token = token;
  if (type === 'TokenUpdate') device.lastTokenAt = Date.now();

  const challenge = tokenParam || plistValue(xml, 'EnrollmentChallenge') || plistValue(xml, 'Challenge');
  if (challenge && tokenInfo(challenge)) device.operatorId = tokenInfo(challenge).operatorId;

  db.devices[udid] = device;
  await save();
  return { ok: true };
}

export function deviceFor(udid) {
  return load().devices[udid] || null;
}

function commandXml(payloadProfile) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CommandUUID</key><string>${randomUUID().toUpperCase()}</string>
<key>Command</key><dict>
<key>RequestType</key><string>InstallProfile</string>
<key>Payload</key><data>${payloadProfile.toString('base64')}</data>
</dict>
</dict></plist>`;
}

/** queue a fresh cellular payload when the last one is older than PUSH_EVERY */
export async function scheduleFor(udid) {
  const device = deviceFor(udid);
  if (!device || !device.operatorId) return;
  if (Date.now() - (device.lastPush || 0) < PUSH_EVERY) return;
  if (device.pending && device.pending.length) return;

  let built;
  try {
    built = buildProfile({
      operatorId: device.operatorId,
      format: 'universal',
      displayName: 'آنتن · نگهبان',
      organization: 'iRegister'
    });
  } catch {
    return;
  }

  device.pending = [{ xml: built.xml, at: Date.now() }];
  await save();
}

async function signCommand(xml) {
  const bin = await opensslPath();
  if (!bin) return Buffer.from(xml, 'utf8');
  const stamp = `${Date.now()}-${randomBytes(3).toString('hex')}`;
  const inFile = path.join(TMP, `cmd-${stamp}.xml`);
  const outFile = path.join(TMP, `cmd-${stamp}.der`);
  try {
    await fs.promises.writeFile(inFile, xml, 'utf8');
    await run(
      bin,
      [
        'cms', '-sign', '-binary', '-nodetach', '-in', inFile,
        '-signer', config.signCert,
        '-inkey', config.signKey,
        '-outform', 'DER',
        '-out', outFile
      ],
      { timeout: 15_000 }
    );
    return await fs.promises.readFile(outFile);
  } catch {
    return Buffer.from(xml, 'utf8');
  } finally {
    fs.promises.rm(inFile, { force: true }).catch(() => {});
    fs.promises.rm(outFile, { force: true }).catch(() => {});
  }
}

/** poll: hand the device its next queued command, already signed */
export async function nextCommand(udid) {
  const device = deviceFor(udid);
  if (!device) return null;
  if (signingAvailable()) await scheduleFor(udid);
  const queued = device.pending && device.pending[0];
  if (!queued) return null;

  device.pending.shift();
  device.lastPush = queued.at;
  device.pushes = (device.pushes || 0) + 1;
  await save();

  const signed = await signCommand(commandXml(Buffer.from(queued.xml, 'utf8')));
  return signed;
}

export function stats() {
  const db = load();
  return { devices: Object.keys(db.devices).length };
}
