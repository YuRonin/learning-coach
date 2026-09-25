import { mkdir, copyFile, readFile, writeFile } from 'node:fs/promises';
import { zipSync, unzipSync } from 'fflate';
import assert from 'node:assert/strict';

const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
assert.equal(manifest.version, pkg.version);
await mkdir('dist/learning-coach', { recursive: true });
const files = {};
for (const file of ['main.js', 'manifest.json', 'styles.css']) {
  await copyFile(file, `dist/learning-coach/${file}`);
  files[`learning-coach/${file}`] = new Uint8Array(await readFile(file));
}
const zip = zipSync(files);
assert.deepEqual(Object.keys(unzipSync(zip)).sort(), Object.keys(files).sort());
const destination = `dist/learning-coach-${manifest.version}.zip`;
await writeFile(destination, zip);
console.log(`Installable plugin: ${destination}`);
