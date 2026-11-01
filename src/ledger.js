/* language: JavaScript (ES2022) | file: src/ledger.js | runtime: Node 20+
   file-backed store, atomic writes, single-writer queue. no external db needed at this scale. */

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const FILE = path.join(DATA_DIR, 'ledger.json');
const MAX_RECORDS = 20_000;

let cache = null;
let writeChain = Promise.resolve();

function load() {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    cache = { version: 1, seq: 0, profiles: {} };
  }
  if (!cache.profiles) cache.profiles = {};
  return cache;
}

function persist() {
  const db = load();
  const tmp = `${FILE}.${process.pid}.tmp`;
  writeChain = writeChain.then(async () => {
    const ids = Object.keys(db.profiles);
    if (ids.length > MAX_RECORDS) {
      ids
        .sort((a, b) => (db.profiles[a].createdAt || 0) - (db.profiles[b].createdAt || 0))
        .slice(0, ids.length - MAX_RECORDS)
        .forEach((id) => delete db.profiles[id]);
    }
    await fs.promises.writeFile(tmp, JSON.stringify(db), 'utf8');
    await fs.promises.rename(tmp, FILE);
  });
  return writeChain;
}

export function createRecord(record) {
  const db = load();
  db.seq += 1;
  db.profiles[record.id] = record;
  persist();
  return record;
}

export function getRecord(id) {
  return load().profiles[id] || null;
}

export function updateRecord(id, patch) {
  const db = load();
  const current = db.profiles[id];
  if (!current) return null;
  db.profiles[id] = { ...current, ...patch };
  persist();
  return db.profiles[id];
}

export function listRecords(limit = 100) {
  const db = load();
  return Object.values(db.profiles)
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .slice(0, limit);
}

export function stats() {
  const db = load();
  const all = Object.values(db.profiles);
  return {
    total: all.length,
    signed: all.filter((p) => p.signed).length,
    bound: all.filter((p) => p.device).length,
    last24h: all.filter((p) => Date.now() - (p.createdAt || 0) < 86_400_000).length
  };
}
