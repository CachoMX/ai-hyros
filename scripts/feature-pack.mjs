/**
 * Pack / install feature folders so features travel between forks.
 *
 *   node scripts/feature-pack.mjs <id>              -> dist/features/<id>-<version>.zip
 *   node scripts/feature-pack.mjs --install <zip>   -> public/features/<id>/ + registry entry, then feature-check
 *   node scripts/feature-pack.mjs --list            -> registered features with versions
 *
 * A pack is just the feature folder (feature.json, view.js, demo.js,
 * server.js, style.css, SPEC.md) — nothing outside it is needed. Install
 * refuses to overwrite an existing feature unless --force is passed.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const featuresDir = `${root}public/features/`;
const registryPath = `${featuresDir}registry.js`;
const args = process.argv.slice(2);
const exists = (p) => stat(p).then(() => true).catch(() => false);

async function registry() {
  const mod = await import(`${registryPath}?t=${Date.now()}`);
  return mod.FEATURES;
}

if (args[0] === '--list' || !args.length) {
  for (const id of await registry()) {
    const m = JSON.parse(await readFile(`${featuresDir}${id}/feature.json`, 'utf8'));
    console.log(`${id.padEnd(12)} v${m.version}  ${m.mode.padEnd(5)}  ${m.name}`);
  }
  process.exit(0);
}

if (args[0] === '--install') {
  const zip = args[1];
  const force = args.includes('--force');
  if (!zip || !(await exists(zip))) { console.error('usage: feature-pack.mjs --install <zip> [--force]'); process.exit(1); }
  const tmp = `${root}dist/.unpack-${Date.now()}/`;
  await mkdir(tmp, { recursive: true });
  execFileSync('unzip', ['-q', zip, '-d', tmp]);
  const entries = execFileSync('ls', [tmp]).toString().trim().split('\n');
  const folder = entries.length === 1 ? `${tmp}${entries[0]}/` : tmp;
  const manifest = JSON.parse(await readFile(`${folder}feature.json`, 'utf8'));
  const id = manifest.id;
  const dest = `${featuresDir}${id}/`;
  if (await exists(dest) && !force) { console.error(`feature "${id}" already exists — pass --force to replace it`); await rm(tmp, { recursive: true }); process.exit(1); }
  await rm(dest, { recursive: true, force: true });
  execFileSync('cp', ['-r', folder, dest]);
  await rm(tmp, { recursive: true });
  const ids = await registry();
  if (!ids.includes(id)) {
    const src = await readFile(registryPath, 'utf8');
    await writeFile(registryPath, src.replace(/export const FEATURES = \[([^\]]*)\];/, (m, inner) => `export const FEATURES = [${inner.trim() ? `${inner.trim().replace(/,\s*$/, '')}, ` : ''}'${id}'];`));
  }
  console.log(`installed ${id} v${manifest.version} → public/features/${id}/ (registered)`);
  execFileSync('node', [`${root}scripts/feature-check.mjs`], { stdio: 'inherit' });
  process.exit(0);
}

const id = args[0];
const src = `${featuresDir}${id}/`;
if (!(await exists(`${src}feature.json`))) { console.error(`no feature at public/features/${id}/`); process.exit(1); }
const manifest = JSON.parse(await readFile(`${src}feature.json`, 'utf8'));
await mkdir(`${root}dist/features`, { recursive: true });
const out = `${root}dist/features/${id}-${manifest.version}.zip`;
await rm(out, { force: true });
execFileSync('zip', ['-qr', out, id, '-x', '*.DS_Store'], { cwd: featuresDir });
console.log(`packed ${id} v${manifest.version} → dist/features/${id}-${manifest.version}.zip`);
