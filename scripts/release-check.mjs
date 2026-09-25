import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { unzipSync } from 'fflate';

const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
assert.match(manifest.version, /^\d+\.\d+\.\d+$/, 'manifest version must be x.y.z');
assert.equal(manifest.version, pkg.version, 'manifest and package versions must match');
assert.ok(manifest.description.length <= 250, 'manifest description must be at most 250 characters');
assert.ok(manifest.description.endsWith('.'), 'manifest description must end with an ASCII period');
for (const file of ['main.js', 'manifest.json', 'styles.css', 'README.md', 'LICENSE']) {
  await readFile(file);
}

const zipName = `dist/learning-coach-${manifest.version}.zip`;
const entries = unzipSync(await readFile(zipName));
const names = Object.keys(entries).sort();
assert.deepEqual(names, ['learning-coach/main.js', 'learning-coach/manifest.json', 'learning-coach/styles.css']);
for (const name of names) {
  const source = new Uint8Array(await readFile(name.replace('learning-coach/', '')));
  assert.deepEqual(entries[name], source, `${name} is stale in the release archive`);
}

const publicText = await Promise.all(['main.js', 'manifest.json', 'README.md', 'LICENSE'].map(file => readFile(file, 'utf8')));
const secretPatterns = [/sk-[A-Za-z0-9]{20,}/, /Bearer\s+[A-Za-z0-9._-]{20,}/, /AIza[0-9A-Za-z_-]{20,}/];
for (const pattern of secretPatterns) assert.ok(!publicText.some(text => pattern.test(text)), `possible credential found: ${pattern}`);
console.log(`Release check passed: ${manifest.version}; package contains no data.json or backup.`);
