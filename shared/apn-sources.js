/* language: JavaScript (ES2022) | file: shared/apn-sources.js | runtime: Node 20+ / Safari 16+
   the one place where a real-SIM confirmation of an APN is recorded.
   catalog.js keeps community defaults; this file only adds evidence on top of them.

   how to verify an APN (see scripts/verify-apn.mjs, which prints this checklist):
     1. put a real SIM of that carrier in an iPhone
     2. Settings > Cellular > Cellular Data Network, or the profile made by this app
     3. confirm the phone attaches and data works with the APN listed in catalog.js
     4. record carrier, APN, iOS version, date and who confirmed it below

   an entry without verifiedAt and verifiedWith does not count as verified; verificationOf()
   in catalog.js ignores it, so a half-filled record can never publish an unverified claim. */

/** @type {Record<string, {apn: string, verifiedAt: string, verifiedWith: string, url?: string}>} */
export const SIM_VERIFIED = Object.freeze({
  // mci: { apn: 'mcinet', verifiedAt: '2026-11-01', verifiedWith: 'iPhone 13, iOS 26, MCI prepaid SIM' },
});

/** merge a recorded confirmation into the catalog's community default for one carrier */
export function sourceFor(operatorId, fallback = {}) {
  const hit = SIM_VERIFIED[operatorId];
  if (!hit) return { ...fallback };
  return {
    kind: 'sim',
    url: hit.url || '',
    verifiedAt: hit.verifiedAt || '',
    verifiedWith: hit.verifiedWith || ''
  };
}
