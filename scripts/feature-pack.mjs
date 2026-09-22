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
 *
 * Pure Node: the zip is written and read here (deflate via zlib), so this
 * runs the same on Windows, macOS and Linux with no shell tools.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, stat, rm, readdir } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deflateRawSync, inflateRawSync } from 'node:zlib';

const root = fileURLToPath(new URL('../', import.meta.url));
const featuresDir = join(root, 'public', 'features');
const registryPath = join(featuresDir, 'registry.js');
const args = process.argv.slice(2);
const exists = (p) => stat(p).then(() => true).catch(() => false);

/* ---------------- minimal ZIP (deflate, no zip64, no encryption) ---------------- */

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function dosTime(d) {
  return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() };
}
/** entries: [{ name, data: Buffer }] -> zip Buffer. Names use forward slashes. */
function zipEntries(entries, when = new Date()) {
  const { time, date } = dosTime(when);
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const packed = deflateRawSync(data);
    const store = packed.length >= data.length;
    const body = store ? data : packed;
    const method = store ? 0 : 8;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8); local.writeUInt16LE(time, 10); local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10); central.writeUInt16LE(time, 12); central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(body.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28); central.writeUInt16LE(0, 30); central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34); central.writeUInt16LE(0, 36); central.writeUInt32LE(0, 38); central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, body);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, cd, end]);
}
/** zip Buffer -> [{ name, data: Buffer }] (files only; CRC verified). */
function unzipEntries(buf) {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('not a zip file (no end-of-central-directory record)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('corrupt zip (central directory)');
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const n = buf.readUInt16LE(p + 28), e = buf.readUInt16LE(p + 30), c = buf.readUInt16LE(p + 32);
    // Some Windows archivers write backslashes; the spec says forward slashes.
    const name = buf.subarray(p + 46, p + 46 + n).toString('utf8').replace(/\\/g, '/');
    const lh = buf.readUInt32LE(p + 42);
    if (buf.readUInt32LE(lh) !== 0x04034b50) throw new Error(`corrupt zip (local header of ${name})`);
    const start = lh + 30 + buf.readUInt16LE(lh + 26) + buf.readUInt16LE(lh + 28);
    const raw = buf.subarray(start, start + csize);
    p += 46 + n + e + c;
    if (name.endsWith('/')) continue;
    if (method !== 0 && method !== 8) throw new Error(`unsupported compression method ${method} for ${name}`);
    const data = method === 8 ? inflateRawSync(raw) : Buffer.from(raw);
    if (crc32(data) !== crc) throw new Error(`CRC mismatch for ${name}`);
    out.push({ name, data });
  }
  return out;
}

/* ---------------- helpers ---------------- */

async function registry() {
  const mod = await import(`${pathToFileURL(registryPath).href}?t=${Date.now()}`);
  return mod.FEATURES;
}
async function walk(dir, prefix = '') {
  const files = [];
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === '.DS_Store') continue;
    const rel = prefix ? posix.join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) files.push(...(await walk(join(dir, entry.name), rel)));
    else files.push({ name: rel, data: await readFile(join(dir, entry.name)) });
  }
  return files;
}
const safeRel = (name) => {
  const parts = name.split('/');
  if (!parts.length || parts.some((s) => s === '' || s === '.' || s === '..') || /^[a-zA-Z]:/.test(name)) throw new Error(`unsafe path in zip: ${name}`);
  return parts;
};

/* ---------------- commands ---------------- */

if (args[0] === '--list' || !args.length) {
  for (const id of await registry()) {
    const m = JSON.parse(await readFile(join(featuresDir, id, 'feature.json'), 'utf8'));
    console.log(`${id.padEnd(12)} v${m.version}  ${m.mode.padEnd(5)}  ${m.name}`);
  }
  process.exit(0);
}

if (args[0] === '--install') {
  const zip = args[1];
  const force = args.includes('--force');
  if (!zip || !(await exists(zip))) { console.error('usage: feature-pack.mjs --install <zip> [--force]'); process.exit(1); }
  const entries = unzipEntries(await readFile(zip));
  // The pack is either `<id>/feature.json …` (what this script writes) or a flat folder.
  const top = entries.find((e) => /^[^/]+\/feature\.json$/.test(e.name))?.name.split('/')[0];
  const strip = top ? `${top}/` : '';
  const manifestEntry = entries.find((e) => e.name === `${strip}feature.json`);
  if (!manifestEntry) { console.error('no feature.json in the zip'); process.exit(1); }
  const manifest = JSON.parse(manifestEntry.data.toString('utf8'));
  const id = manifest.id;
  if (!/^[a-z][a-z0-9-]{1,30}$/.test(String(id))) { console.error(`invalid feature id in manifest: ${id}`); process.exit(1); }
  const dest = join(featuresDir, id);
  if (await exists(dest) && !force) { console.error(`feature "${id}" already exists — pass --force to replace it`); process.exit(1); }
  await rm(dest, { recursive: true, force: true });
  for (const e of entries.filter((x) => x.name.startsWith(strip))) {
    const parts = safeRel(e.name.slice(strip.length));
    await mkdir(join(dest, ...parts.slice(0, -1)), { recursive: true });
    await writeFile(join(dest, ...parts), e.data);
  }
  const ids = await registry();
  if (!ids.includes(id)) {
    const src = await readFile(registryPath, 'utf8');
    await writeFile(registryPath, src.replace(/export const FEATURES = \[([^\]]*)\];/, (m, inner) => `export const FEATURES = [${inner.trim() ? `${inner.trim().replace(/,\s*$/, '')}, ` : ''}'${id}'];`));
  }
  console.log(`installed ${id} v${manifest.version} → public/features/${id}/ (registered)`);
  execFileSync(process.execPath, [join(root, 'scripts', 'feature-check.mjs')], { stdio: 'inherit' });
  process.exit(0);
}

const id = args[0];
const src = join(featuresDir, id);
if (!(await exists(join(src, 'feature.json')))) { console.error(`no feature at public/features/${id}/`); process.exit(1); }
const manifest = JSON.parse(await readFile(join(src, 'feature.json'), 'utf8'));
await mkdir(join(root, 'dist', 'features'), { recursive: true });
const out = join(root, 'dist', 'features', `${id}-${manifest.version}.zip`);
const files = (await walk(src)).map((f) => ({ name: `${id}/${f.name}`, data: f.data }));
await writeFile(out, zipEntries(files));
console.log(`packed ${id} v${manifest.version} → dist/features/${id}-${manifest.version}.zip (${files.length} files)`);
