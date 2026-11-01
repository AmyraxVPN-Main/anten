import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const files = ['server.js'];
for (const directory of ['src', 'shared', 'public', 'scripts']) {
  for (const file of fs.readdirSync(path.join(root, directory))) {
    if (/\.m?js$/.test(file)) files.push(`${directory}/${file}`);
  }
}
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', path.join(root, file)], { encoding: 'utf8' });
  if (result.status !== 0) { console.error(file, result.stderr); process.exit(1); }
}
console.log(`${files.length} JavaScript files passed syntax checks`);
