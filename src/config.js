/* language: JavaScript (ES2022) | file: src/config.js | runtime: Node 20+ */

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PUBLIC_DIR = path.join(ROOT, 'public');
export const SHARED_DIR = path.join(ROOT, 'shared');
export const DATA_DIR = path.join(ROOT, 'data');
export const CERT_DIR = path.join(ROOT, 'certs');

fs.mkdirSync(DATA_DIR, { recursive: true });

function readSecret() {
  if (process.env.SECRET) return process.env.SECRET;
  const file = path.join(DATA_DIR, 'secret.key');
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    const generated = randomBytes(32).toString('hex');
    fs.writeFileSync(file, generated, { mode: 0o600 });
    return generated;
  }
}

const int = (value, fallback) => {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
};

export const config = {
  port: int(process.env.PORT, 8787),
  host: process.env.HOST || '0.0.0.0',
  baseUrl: (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, ''),
  adminKey: process.env.ADMIN_KEY || '',
  tokenTtlMinutes: int(process.env.TOKEN_TTL_MIN, 60 * 24 * 7),
  rateLimitWindowMs: int(process.env.RATE_WINDOW_MS, 60_000),
  rateLimitMax: int(process.env.RATE_MAX, 40),
  bindDevice: process.env.BIND_DEVICE !== '0',
  secret: readSecret(),
  signCert: process.env.SIGN_CERT || path.join(CERT_DIR, 'profile.crt'),
  signKey: process.env.SIGN_KEY || path.join(CERT_DIR, 'profile.key'),
  signChain: process.env.SIGN_CHAIN || path.join(CERT_DIR, 'ca.crt'),
  openssl: process.env.OPENSSL_BIN || ''
};
