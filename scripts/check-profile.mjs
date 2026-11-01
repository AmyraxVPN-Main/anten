import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { buildProfile } from '../shared/profile.js';
import { OPERATORS } from '../shared/catalog.js';

const fixtures = [];
for (const format of ['universal', 'modern', 'legacy']) {
  for (const operatorId of ['mci', 'irancell', 'rightel', 'aptel', 'shatel', 'samantel', 'all', 'custom']) {
    for (const protocol of ['ipv4', 'ipv6', 'both']) {
      const built = buildProfile({ format, operatorId, protocol, omitCredentials:false, customEntries: [{ apn: 'sample.apn', username: 'a&<b', password: 'p>q' }] });
      assert.equal(buildProfile({ ...built.opts, uuids: built.uuids }).xml, built.xml, `round trip: ${operatorId}/${format}/${protocol}`);
      assert.ok(built.xml.includes('<key>APNs</key>'));
      assert.ok(!built.xml.includes('<key>APN</key>'));
      assert.equal(built.xml.includes('<key>EnableXLAT464</key>'), format !== 'legacy');
      fixtures.push(built.xml);
    }
  }
}
for (const options of [null, [], {operatorId:'unknown'}, {operatorId:'custom'},
  {primaryApn:'a'.repeat(101)}, {primaryApn:'bad\u0000apn'}, {primaryApn:'x</string>'},
  {proxy:'localhost'}, {proxyPort:'80oops'}, {proxyUsername:'unsupported'}, {removalDate:'bad'}, {uuids:{root:'bad'}},
  {protocol:'constructor'}, {format:'invalid'}, {attach:'false'},
  {webClip:true,webClipUrl:'javascript:alert(1)'}]) {
  assert.throws(() => buildProfile(options), `invalid input: ${JSON.stringify(options)}`);
}
assert.notEqual(buildProfile().uuids.root, buildProfile().uuids.root);
const noAuth = buildProfile({auth:'NONE', attach:false}).xml;
assert.ok(!noAuth.includes('<key>AuthenticationType</key>'));
assert.ok(!noAuth.includes('<key>AttachAPN</key>'));
const attach = buildProfile({attach:true}).xml.match(/<key>AttachAPN<\/key>\s*(<dict>[\s\S]*?<\/dict>)/)[1];
assert.ok(!/EnableXLAT464|DefaultProtocolMask|AllowedProtocolMaskIn/.test(attach));
const referenceFixtures = ['mci', 'irancell'].map((operatorId) => {
  const built = buildProfile({operatorId, preset:'reference', proxy:'stale', proxyPort:8080, webClip:true});
  assert.equal(buildProfile({...built.opts, uuids:built.uuids}).xml, built.xml);
  return built.xml;
});
const compare = spawnSync('python', ['-c', `import sys,json,plistlib
items=json.loads(sys.stdin.buffer.read().decode('utf-8'))
meta={'PayloadDisplayName','PayloadDescription','PayloadIdentifier','PayloadType','PayloadUUID','PayloadVersion'}
for xml,apn,mask,attach in zip(items,['mcinet','mtnirancell'],[3,1],[False,True]):
 p=plistlib.loads(xml.encode('utf-8')); assert len(p['PayloadContent'])==1
 cell=p['PayloadContent'][0]; effective={k:v for k,v in cell.items() if k not in meta}
 entry={'AllowedProtocolMask':mask,'AllowedProtocolMaskInDomesticRoaming':mask,'AllowedProtocolMaskInRoaming':mask,'AuthenticationType':'PAP','EnableXLAT464':False,'Name':apn}
 expected={'APNs':[entry]}
 if attach: expected['AttachAPN']={'AllowedProtocolMask':mask,'AuthenticationType':'PAP','Name':apn}
 assert effective==expected,(effective,expected)
print('Both reference payloads match every effective key and value')`], {input:Buffer.from(JSON.stringify(referenceFixtures)),encoding:'utf8'});
assert.equal(compare.status, 0, compare.stderr);
console.log(compare.stdout.trim());
for (const op of OPERATORS) {
  const options = { operatorId:op.id, preset:'simple', customEntries:[{apn:'custom.apn',username:'ignored',password:'ignored'}] };
  const built = buildProfile(options);
  assert.equal(built.opts.auth, 'PAP');
  assert.equal(built.opts.xlat, false);
  assert.ok(built.opts.entries.every((e) => !e.username && !e.password));
  assert.equal(buildProfile({...built.opts,uuids:built.uuids}).xml, built.xml);
  fixtures.push(built.xml);
}
console.log('Simple profiles work for all 8 operator choices');
const python = spawnSync('python', ['-c', 'import json,sys,plistlib; items=json.loads(sys.stdin.buffer.read().decode("utf-8")); parsed=[plistlib.loads(x.encode("utf-8")) for x in items]; assert all(p["PayloadRemovalDisallowed"] is False for p in parsed); print(str(len(parsed))+" plist profiles parsed")'], { input: Buffer.from(JSON.stringify(fixtures)), encoding:'utf8' });
assert.equal(python.status, 0, python.stderr || python.error?.message);
console.log(python.stdout.trim());
console.log('Round trips, unique identifiers, invalid inputs and optional fields passed');
