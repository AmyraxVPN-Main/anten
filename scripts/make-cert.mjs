/* language: JavaScript (ES2022) | file: scripts/make-cert.mjs | runtime: Node 20+ + openssl
   creates a local CA and a leaf certificate used for CMS signing of .mobileconfig files.
   iOS trusts the profile only if the CA is installed on the device; unsigned profiles install fine. */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { CERT_DIR } from '../src/config.js';
import { opensslPath } from '../src/sign.js';

const run = promisify(execFile);

const bin = await opensslPath();
if (!bin) {
  console.error('openssl not found. install openssl or set OPENSSL_BIN, then rerun.');
  process.exit(1);
}

fs.mkdirSync(CERT_DIR, { recursive: true });

const caKey = path.join(CERT_DIR, 'ca.key');
const caCrt = path.join(CERT_DIR, 'ca.crt');
const leafKey = path.join(CERT_DIR, 'profile.key');
const leafCsr = path.join(CERT_DIR, 'profile.csr');
const leafCrt = path.join(CERT_DIR, 'profile.crt');
const extFile = path.join(CERT_DIR, 'profile.ext');

console.log('openssl:', bin);

await run(bin, [
  'req', '-x509', '-newkey', 'rsa:3072', '-nodes',
  '-keyout', caKey, '-out', caCrt,
  '-days', '3650',
  '-subj', '/C=IR/O=iRegister/CN=iRegister Profile CA',
  '-addext', 'basicConstraints=critical,CA:TRUE',
  '-addext', 'keyUsage=critical,keyCertSign,cRLSign'
]);

await run(bin, [
  'req', '-newkey', 'rsa:2048', '-nodes',
  '-keyout', leafKey, '-out', leafCsr,
  '-subj', '/C=IR/O=iRegister/CN=iRegister Profile Signer'
]);

fs.writeFileSync(
  extFile,
  ['basicConstraints=critical,CA:FALSE', 'keyUsage=critical,digitalSignature', 'extendedKeyUsage=emailProtection', ''].join('\n')
);

await run(bin, [
  'x509', '-req',
  '-in', leafCsr,
  '-CA', caCrt,
  '-CAkey', caKey,
  '-CAcreateserial',
  '-out', leafCrt,
  '-days', '1095',
  '-sha256',
  '-extfile', extFile
]);

console.log('written:');
for (const file of [caKey, caCrt, leafKey, leafCrt]) console.log('  ', file);
console.log('\nrestart the server to pick up signing. install certs/ca.crt on test devices only.');
