/* language: JavaScript (ES2022) | file: shared/catalog.js | runtime: Node 20+ / Safari 16+
   carrier catalog + iOS compatibility matrix.
   APN values here are community defaults, every field is overridable from the UI.
   never hard-code an APN in the builder: read it through this file. */

import { SIM_VERIFIED } from './apn-sources.js';

/** bit flags for AllowedProtocolMask / DefaultProtocolMask (Apple DDNA) */
export const PROTOCOL = Object.freeze({ ipv4: 1, ipv6: 2, both: 3 });

/**
 * where an APN value came from.
 * nothing is verified until someone ran it on a real SIM of that carrier and recorded the date,
 * so `community` and `official` both count as unverified. `sim` is the only verified kind.
 */
export const SOURCE_KINDS = Object.freeze({
  community: { fa: 'مقدار رایج جامعه', verified: false },
  official: { fa: 'سند اپراتور', verified: false },
  sim: { fa: 'تأیید با سیم‌کارت واقعی', verified: true }
});

/** source shape for an operator whose APN has not been checked on a SIM yet */
const community = () => ({ kind: 'community', url: '', verifiedAt: '', verifiedWith: '' });

/** every carrier the generator knows about. entries[] is the APN list attached to the profile. */
export const OPERATORS = [
  {
    id: 'mci',
    fa: 'همراه اول',
    en: 'MCI',
    entries: [{ apn: 'mcinet' }],
    auth: 'PAP',
    xlat: false,
    source: community()
  },
  {
    id: 'irancell',
    fa: 'ایرانسل',
    en: 'Irancell',
    entries: [{ apn: 'mtnirancell' }],
    auth: 'PAP',
    xlat: false,
    source: community()
  },
  {
    id: 'rightel',
    fa: 'رایتل',
    en: 'Rightel',
    entries: [{ apn: 'rightel' }],
    auth: 'PAP',
    xlat: false,
    source: community()
  },
  {
    id: 'aptel',
    fa: 'آپتل',
    en: 'ApTel',
    entries: [{ apn: 'aptel' }],
    auth: 'PAP',
    xlat: false,
    source: community()
  },
  {
    id: 'shatel',
    fa: 'شاتل موبایل',
    en: 'Shatel Mobile · 0998',
    entries: [{ apn: 'shatelmobile' }],
    auth: 'PAP',
    xlat: false,
    source: community()
  },
  {
    id: 'samantel',
    fa: 'سامانتل',
    en: 'Samantel',
    entries: [{ apn: 'samantel' }],
    auth: 'PAP',
    xlat: false,
    source: community()
  },
  {
    id: 'all',
    fa: 'همه اپراتورها',
    en: 'MCI + Irancell + Rightel',
    entries: 'union',
    auth: 'PAP',
    xlat: false,
    source: community()
  },
  {
    id: 'custom',
    fa: 'سایر اپراتورها',
    en: 'Custom APN',
    entries: [],
    auth: 'PAP',
    xlat: false,
    source: community()
  }
];

/** All variants use the documented Cellular payload; legacy omits iOS 16 XLAT. */
export const FORMATS = [
  {
    id: 'universal',
    fa: 'سلولی استاندارد',
    en: 'iOS 9 → 26',
    desc: 'آرایه APNs استاندارد؛ 464XLAT فقط از iOS 16 پشتیبانی می‌شود'
  },
  {
    id: 'modern',
    fa: 'فقط iOS 16 و بالاتر',
    en: 'iOS 16 → 26',
    desc: 'آرایه APNs با گزینه 464XLAT برای iOS 16 و بالاتر'
  },
  {
    id: 'legacy',
    fa: 'فقط iOS 15 و پایین‌تر',
    en: 'iOS 9 → 15',
    desc: 'آرایه APNs استاندارد، بدون کلید 464XLAT'
  }
];

/** device ranges, used by the guide + auto-detected default */
export const IOS_MATRIX = [
  {
    range: 'iOS 9 تا 15',
    models: 'بر اساس نسخه سیستم، نه صرفاً مدل دستگاه',
    format: 'legacy',
    note: 'ساختار Cellular از iOS 7 معرفی شده؛ این قالب 464XLAT ندارد.'
  },
  {
    range: 'iOS 16 تا 18',
    models: 'مدل‌های پشتیبانی‌شده توسط نسخه نصب‌شده',
    format: 'modern',
    note: '464XLAT از iOS 16 اضافه شده؛ نتیجه با اپراتور واقعی بررسی شود.'
  },
  {
    range: 'iOS 26 و بالاتر',
    models: 'مدل‌های پشتیبانی‌شده توسط همان نسخه',
    format: 'modern',
    note: 'قالب استاندارد؛ نتیجهٔ واقعی روی همه مدل‌ها تأیید نشده است.'
  }
];

/** carrier-side APN used by the whitelist path that reaches my.hamta.ir while the IMEI is still unregistered */
export const REGISTRY_APN = Object.freeze({
  mci: 'mcinet',
  irancell: 'mtnirancell',
  rightel: 'rightel'
});

/** expand an operator id (or 'all') into the concrete APN entry list */
export function resolveEntries(operatorId, customEntries = []) {
  const op = OPERATORS.find((o) => o.id === operatorId) || OPERATORS[0];
  let list;

  if (op.id === 'all') {
    const seen = new Set();
    list = [];
    for (const o of OPERATORS) {
      if (!Array.isArray(o.entries)) continue;
      for (const e of o.entries) {
        const key = String(e.apn).toLowerCase();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        list.push({ ...e, source: o.id });
      }
    }
  } else if (op.id === 'custom') {
    list = customEntries
      .filter((e) => e && String(e.apn).trim())
      .map((e) => ({
        apn: String(e.apn).trim(),
        username: e.username ? String(e.username).trim() : '',
        password: e.password ? String(e.password).trim() : ''
      }));
  } else {
    list = op.entries.map((e) => ({ ...e }));
  }

  return list;
}

export function operatorById(id) {
  return OPERATORS.find((o) => o.id === id) || null;
}

/**
 * verification state of one operator's APN values.
 * a source only counts as verified when a real SIM of that carrier confirmed it and the date is
 * recorded; a claimed `sim` source without a date or a confirming device stays unverified.
 */
export function verificationOf(operatorId) {
  const op = operatorById(operatorId);
  if (!op) return { operatorId, verified: false, kind: 'community', label: SOURCE_KINDS.community.fa, url: '', verifiedAt: '', verifiedWith: '' };

  const src = op.source || community();
  const kind = SOURCE_KINDS[src.kind] ? src.kind : 'community';
  const claimed = SOURCE_KINDS[kind].verified;
  const evidenced = Boolean(src.verifiedAt) && Boolean(src.verifiedWith);
  const verified = claimed && evidenced;

  return {
    operatorId: op.id,
    verified,
    kind,
    label: verified ? SOURCE_KINDS.sim.fa : SOURCE_KINDS[kind].fa,
    url: verified ? String(src.url || '') : '',
    verifiedAt: verified ? String(src.verifiedAt) : '',
    verifiedWith: verified ? String(src.verifiedWith) : ''
  };
}

/** every operator whose APN has not been confirmed on a real SIM, for the release checklist */
export function unverifiedOperators() {
  return OPERATORS.filter((o) => o.id !== 'all' && o.id !== 'custom').map((o) => verificationOf(o.id)).filter((v) => !v.verified);
}
