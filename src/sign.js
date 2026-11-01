/* language: JavaScript (ES2022) | file: src/sign.js | runtime: Node 20+
   detached-free CMS (PKCS#7) signing via openssl. iOS shows the "Verified" badge only when the
   signing chain is trusted on the device; an unsigned profile installs fine over HTTPS. */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { CERT_DIR, DATA_DIR, config } from './config.js';

const run = promisify(execFile);
const TMP = path.join(DATA_DIR, 'tmp');
fs.mkdirSync(TMP, { recursive: true });

const CANDIDATES = [
  config.openssl,
  'openssl',
  'C:\\Program Files\\Git\\usr\\bin\\openssl.exe',
  'C:\\Program Files\\OpenSSL-Win64\\bin\\openssl.exe',
  '/usr/bin/openssl',
  '/usr/local/bin/openssl'
].filter(Boolean);

let resolved = null;

export async function opensslPath() {
  if (resolved !== null) return resolved || null;
  for (const bin of CANDIDATES) {
    try {
      await run(bin, ['version'], { timeout: 4000 });
      resolved = bin;
      return bin;
    } catch {
      /* try next */
    }
  }
  resolved = '';
  return null;
}

export function signingAvailable() {
  return fs.existsSync(config.signCert) && fs.existsSync(config.signKey);
}

export function signingStatus() {
  return {
    available: signingAvailable(),
    cert: signingAvailable() ? path.basename(config.signCert) : null,
    chain: fs.existsSync(config.signChain) ? path.basename(config.signChain) : null
  };
}

const cache = new Map();

/** sign a profile XML, returns DER CMS bytes. throws when signing is not configured. */
export async function signProfile(id, xml) {
  const hit = cache.get(id);
  if (hit) return hit;

  const bin = await opensslPath();
  if (!bin) throw new Error('openssl پیدا نشد');
  if (!signingAvailable()) throw new Error('گواهی امضا تنظیم نشده است');

  const base = path.join(TMP, `sign-${id}-${Date.now()}`);
  const inFile = `${base}.xml`;
  const outFile = `${base}.der`;

  try {
    await fs.promises.writeFile(inFile, xml, 'utf8');
    const args = [
      'cms', '-sign',
      '-nodetach',
      '-binary',
      '-in', inFile,
      '-signer', config.signCert,
      '-inkey', config.signKey,
      '-outform', 'DER',
      '-out', outFile
    ];
    if (fs.existsSync(config.signChain)) args.push('-certfile', config.signChain);
    await run(bin, args, { timeout: 15_000 });
    const der = await fs.promises.readFile(outFile);
    cache.set(id, der);
    return der;
  } finally {
    fs.promises.rm(inFile, { force: true }).catch(() => {});
    fs.promises.rm(outFile, { force: true }).catch(() => {});
  }
}

export function ensureCertDir() {
  fs.mkdirSync(CERT_DIR, { recursive: true });
}
