import { execFileSync } from 'node:child_process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';

// Reports locations and categories only. Never prints matching credential content.
const patterns = [
  ['service-key', /\bsk-[A-Za-z0-9_-]{20,}/],
  ['bearer-token', /Bearer\s+[A-Za-z0-9._-]{20,}/],
  ['google-key', /AIza[0-9A-Za-z_-]{20,}/],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/],
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
];
const privateFile = /(?:^|\/)(?:data(?:\.[^/]*)?\.json|learning-cache\.json|\.env(?:\.[^/]*)?)$/;
const localOnly = /^(?:AGENTS\.md$|CLAUDE\.md$|design-system\/|docs\/(?:optimization-plan\.md$|release-acceptance\.md$|publishing\.md$|internal\/)|\.?plans\/|dist\/|\.test-artifacts\/|node_modules\/|main\.js$)|\.(?:zip|tar\.gz)$/;
const git = args => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const findings = [];
function inspect(location, text) { for (const [category, pattern] of patterns) if (pattern.test(text)) findings.push({ location, category }); }
const files = git(['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
for (const file of new Set(files)) {
  if (privateFile.test(file)) findings.push({ location: file, category: 'private-file-name' });
  if (localOnly.test(file)) findings.push({ location: file, category: 'local-only-file' });
  try { inspect(file, await readFile(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
}
const objects = git(['rev-list', '--objects', '--all']).trim().split('\n').filter(Boolean);
let blobs = 0;
for (const entry of objects) {
  const [id, ...parts] = entry.split(' '); const file = parts.join(' ');
  if (!file || git(['cat-file', '-t', id]).trim() !== 'blob') continue;
  blobs++;
  if (privateFile.test(file)) findings.push({ location: `${id.slice(0, 12)}:${file}`, category: 'historical-private-file-name' });
  inspect(`${id.slice(0, 12)}:${file}`, git(['cat-file', 'blob', id]));
}
for (const file of ['main.js', 'manifest.json', 'styles.css']) inspect(`build:${file}`, await readFile(file, 'utf8'));
await mkdir('.test-artifacts/security', { recursive: true });
await writeFile('.test-artifacts/security/report.json', JSON.stringify({ checkedAt: new Date().toISOString(), files: files.length, historicalBlobs: blobs, findings,
  limitation: 'Pattern scan only; does not identify arbitrary private URLs, notes, images, or unknown credential formats.' }, null, 2));
console.log(`Checked ${files.length} working files, ${blobs} historical blobs and three build files; ${findings.length} flagged locations.`);
if (findings.length) { console.log(JSON.stringify(findings, null, 2)); process.exitCode = 1; }
