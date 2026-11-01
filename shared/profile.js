/* language: JavaScript (ES2022) | file: shared/profile.js | runtime: Node 20+ / Safari 16+
   pure module, imported by server.js and by public/app.js, no node or DOM APIs.
   builds an iOS configuration profile whose com.apple.cellular payload re-provisions carrier
   settings (DDNA APNs array on iOS 16+, legacy APN keys below that). */

import { OPERATORS, PROTOCOL, resolveEntries, operatorById } from './catalog.js';

const CONTROL_CHARS = /[\u0000-\u001F\u007F]/g;
const APN_RE = /^[A-Za-z0-9._-]{1,100}$/;

export function newUuid() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  // insecure context fallback (plain http on a LAN ip), identifier only, never a secret
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    const v = ch === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function str(value, max = 100) {
  return String(value ?? '').replace(CONTROL_CHARS, '').trim().slice(0, max);
}

function assertApn(apn) {
  if (!APN_RE.test(apn)) {
    throw new Error('APN نامعتبر: فقط حروف انگلیسی، رقم، نقطه، خط تیره و زیرخط تا ۱۰۰ کاراکتر.');
  }
}

/** normalize the option bag coming from the UI or the API into a deterministic shape */
export function normalizeOptions(input = {}) {
  const operatorId = operatorById(input.operatorId)?.id || 'mci';
  const op = operatorById(operatorId);

  const customEntries = Array.isArray(input.customEntries)
    ? input.customEntries.slice(0, 8).map((e) => ({
        apn: str(e?.apn, 100),
        username: str(e?.username, 64),
        password: str(e?.password, 64)
      }))
    : [];

  let entries = resolveEntries(operatorId, customEntries);
  if (!entries.length) entries = [{ apn: 'internet' }];

  if (input.primaryApn) {
    const forced = str(input.primaryApn, 100);
    if (forced) entries = [{ ...entries[0], apn: forced }, ...entries.slice(1)];
  }
  for (const e of entries) assertApn(e.apn);

  const format = ['universal', 'modern', 'legacy'].includes(input.format) ? input.format : 'universal';
  const protocol = ['both', 'ipv4', 'ipv6'].includes(input.protocol) ? input.protocol : 'both';
  const auth = ['PAP', 'CHAP', 'NONE'].includes(input.auth) ? input.auth : (op?.auth || 'PAP');

  const proxyPort = Number.parseInt(input.proxyPort, 10);

  return {
    operatorId,
    operatorLabel: op ? op.fa : 'سفارشی',
    entries,
    customEntries,
    primaryApn: input.primaryApn ? str(input.primaryApn, 100) : '',
    format,
    protocol: PROTOCOL[protocol],
    auth,
    xlat: input.xlat === undefined ? Boolean(op?.xlat ?? true) : Boolean(input.xlat),
    attach: input.attach === undefined ? true : Boolean(input.attach),
    proxy: input.proxy ? str(input.proxy, 120) : '',
    proxyPort: Number.isFinite(proxyPort) && proxyPort > 0 && proxyPort < 65536 ? proxyPort : null,
    proxyUsername: str(input.proxyUsername, 64),
    proxyPassword: str(input.proxyPassword, 64),
    displayName: str(input.displayName, 64) || 'آنتن',
    organization: str(input.organization, 64) || 'iRegister',
    consent: str(input.consent, 240),
    removalDate: input.removalDate ? new Date(input.removalDate) : null,
    webClip: Boolean(input.webClip),
    webClipUrl: str(input.webClipUrl, 200) || 'https://my.hamta.ir',
    webClipLabel: str(input.webClipLabel, 24) || 'همتا',
    uuids: input.uuids || null
  };
}

/* ---------- plist serialization ---------- */

function esc(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function serialize(value, depth = 0) {
  const pad = '\t'.repeat(depth);
  const padIn = '\t'.repeat(depth + 1);

  if (value === true) return '<true/>';
  if (value === false) return '<false/>';
  if (typeof value === 'number') {
    return Number.isInteger(value) ? `<integer>${value}</integer>` : `<real>${value}</real>`;
  }
  if (value instanceof Date) {
    return `<date>${value.toISOString().replace(/\.\d{3}Z$/, 'Z')}</date>`;
  }
  if (typeof value === 'string') return `<string>${esc(value)}</string>`;
  if (Array.isArray(value)) {
    if (!value.length) return '<array/>';
    const items = value.map((v) => `${padIn}${serialize(v, depth + 1)}`).join('\n');
    return `<array>\n${items}\n${pad}</array>`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined && v !== null);
    if (!entries.length) return '<dict/>';
    const items = entries
      .map(([k, v]) => `${padIn}<key>${esc(k)}</key>\n${padIn}${serialize(v, depth + 1)}`)
      .join('\n');
    return `<dict>\n${items}\n${pad}</dict>`;
  }
  return `<string>${esc(value)}</string>`;
}

function plist(root) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    serialize(root, 0),
    '</plist>',
    ''
  ].join('\n');
}

/* ---------- payload pieces ---------- */

function proxyFields(opts) {
  const fields = {};
  if (opts.proxy && opts.proxyPort) {
    fields.ProxyServer = opts.proxy;
    fields.ProxyPort = opts.proxyPort;
    if (opts.proxyUsername) fields.ProxyUsername = opts.proxyUsername;
    if (opts.proxyPassword) fields.ProxyPassword = opts.proxyPassword;
  }
  return fields;
}

function ddnEntry(entry, opts) {
  const item = {
    AllowedProtocolMask: opts.protocol,
    AllowedProtocolMaskInDomesticRoaming: opts.protocol,
    AllowedProtocolMaskInRoaming: opts.protocol,
    AuthenticationType: opts.auth === 'NONE' ? 'PAP' : opts.auth,
    DefaultProtocolMask: opts.protocol,
    EnableXLAT464: opts.xlat,
    Name: entry.apn
  };
  if (entry.username) item.Username = entry.username;
  if (entry.password) item.Password = entry.password;
  return Object.assign(item, proxyFields(opts));
}

function cellularPayload(opts) {
  const uuid = opts.uuids?.cell || newUuid();
  const payload = {
    PayloadDisplayName: 'Cellular',
    PayloadIdentifier: `com.apple.cellular.${uuid.toUpperCase()}`,
    PayloadType: 'com.apple.cellular',
    PayloadUUID: uuid,
    PayloadVersion: 1
  };

  if (opts.format !== 'legacy') {
    payload.APNs = opts.entries.map((e) => ddnEntry(e, opts));
    if (opts.attach) {
      const first = opts.entries[0];
      payload.AttachAPN = {
        AllowedProtocolMask: opts.protocol,
        AllowedProtocolMaskInDomesticRoaming: opts.protocol,
        AllowedProtocolMaskInRoaming: opts.protocol,
        AuthenticationType: opts.auth === 'NONE' ? 'PAP' : opts.auth,
        DefaultProtocolMask: opts.protocol,
        EnableXLAT464: opts.xlat,
        Name: first.apn
      };
      if (first.username) payload.AttachAPN.Username = first.username;
      if (first.password) payload.AttachAPN.Password = first.password;
    }
    // NONE = let the network pick the auth method
    for (const e of payload.APNs) if (opts.auth === 'NONE') delete e.AuthenticationType;
    if (payload.AttachAPN && opts.auth === 'NONE') delete payload.AttachAPN.AuthenticationType;
  }

  if (opts.format !== 'modern') {
    const first = opts.entries[0];
    payload.APN = first.apn;
    if (first.username) payload.Username = first.username;
    if (first.password) payload.Password = first.password;
    Object.assign(payload, proxyFields(opts));
  }

  return payload;
}

function webClipPayload(opts) {
  const uuid = opts.uuids?.webClip || newUuid();
  return {
    PayloadDisplayName: opts.webClipLabel,
    PayloadIdentifier: `com.apple.webClip.managed.${uuid.toUpperCase()}`,
    PayloadType: 'com.apple.webClip.managed',
    PayloadUUID: uuid,
    PayloadVersion: 1,
    Label: opts.webClipLabel,
    URL: opts.webClipUrl,
    IsRemovable: true,
    FullScreen: false
  };
}

/**
 * build the full .mobileconfig XML.
 * @param {object} input  raw option bag (see normalizeOptions)
 * @returns {{xml:string, opts:object, uuids:object}}
 */
export function buildProfile(input = {}) {
  const opts = normalizeOptions(input);
  const uuids = {
    root: opts.uuids?.root || newUuid(),
    cell: opts.uuids?.cell || newUuid(),
    webClip: opts.uuids?.webClip || newUuid()
  };
  const withIds = { ...opts, uuids };

  const content = [cellularPayload(withIds)];
  if (opts.webClip) content.push(webClipPayload(withIds));

  const root = {
    ConsentText: {
      default:
        opts.consent ||
        'این پروفایل تنظیمات شبکه سلولی را روی دستگاه اعمال می‌کند. فقط روی همان گوشی نصب شود که برای آن ساخته شده است.'
    },
    PayloadContent: content,
    PayloadDescription: `آنتن، ${opts.operatorLabel} · ${opts.entries.map((e) => e.apn).join(', ')}`,
    PayloadDisplayName: opts.displayName,
    PayloadIdentifier: `ir.iregister.profile.${uuids.root.toUpperCase()}`,
    PayloadOrganization: opts.organization,
    PayloadRemovalDisallowed: true,
    PayloadType: 'Configuration',
    PayloadUUID: uuids.root,
    PayloadVersion: 1
  };

  if (opts.removalDate && !Number.isNaN(opts.removalDate.getTime())) {
    root.RemovalDate = opts.removalDate;
  }

  return { xml: plist(root), opts, uuids };
}

/** iOS version → recommended profile format */
export function formatForIos(major) {
  const n = Number(major);
  if (!Number.isFinite(n) || n <= 0) return 'universal';
  if (n >= 16) return 'universal';
  if (n >= 10) return 'legacy';
  return 'legacy';
}

/** quick self-check used by /api/health and tests */
export function selfTest() {
  const { xml } = buildProfile({ operatorId: 'mci' });
  const ok = xml.includes('com.apple.cellular') && xml.includes('mcinet') && xml.startsWith('<?xml');
  return { ok, bytes: xml.length, operators: OPERATORS.length };
}
