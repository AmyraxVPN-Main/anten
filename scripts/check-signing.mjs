/* language: JavaScript (ES2022) | file: scripts/check-signing.mjs | runtime: Node 20+
   downloads a freshly minted profile and verifies the CMS signature with openssl. */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { opensslPath } from '../src/sign.js';

const run = promisify(execFile);
const base = process.argv[2] || 'http://127.0.0.1:8787';

// scratch dir: signing artifacts must never land in the repository
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ir-sign-'));
const signed = path.join(dir, 'signed.mobileconfig');
const verified = path.join(dir, 'verified.xml');

try {
  const created = await (
    await fetch(`${base}/api/profile`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operatorId: 'irancell' })
    })
  ).json();

  const res = await fetch(created.downloadUrl);
  const bytes = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(signed, bytes);

  console.log('status      :', res.status);
  console.log('content-type:', res.headers.get('content-type'));
  console.log('bytes       :', bytes.length);
  console.log('der tag     :', bytes[0] === 0x30 ? 'SEQUENCE (cms)' : `0x${bytes[0].toString(16)}`);

  const bin = await opensslPath();
  const verify = await run(bin, ['cms', '-verify', '-inform', 'DER', '-in', signed, '-noverify', '-out', verified]);
  const xml = fs.readFileSync(verified, 'utf8');
  console.log('verified    :', xml.includes('com.apple.cellular') ? 'payload intact' : 'PAYLOAD MISMATCH');
  console.log('stderr      :', verify.stderr.trim() || '(none)');

  if (!xml.includes('com.apple.cellular')) process.exitCode = 1;
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
