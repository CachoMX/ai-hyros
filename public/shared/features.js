/**
 * Feature loader — shared by the browser (app.js) and Node (make-seed,
 * feature-check). A feature is a folder under public/features/<id>/ listed
 * in registry.js; see FEATURES.md for the contract.
 *
 *   loadFeatures()            -> [{ id, manifest, view, demo }]   (view/demo modules)
 *   applyDemoFeatures(snap)   -> attaches each feature's demo block to a demo snapshot
 */
import { FEATURES } from '../features/registry.js';

const isNode = typeof window === 'undefined';

async function readManifest(id) {
  if (isNode) {
    const { readFile } = await import('node:fs/promises');
    return JSON.parse(await readFile(new URL(`../features/${id}/feature.json`, import.meta.url), 'utf8'));
  }
  const res = await fetch(`/features/${id}/feature.json`, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`feature ${id}: manifest HTTP ${res.status}`);
  return res.json();
}

const modUrl = (id, file) => (isNode ? new URL(`../features/${id}/${file}`, import.meta.url).href : `/features/${id}/${file}`);

export function validateManifest(m, id) {
  const problems = [];
  if (m.id !== id) problems.push(`id "${m.id}" does not match folder "${id}"`);
  if (!/^[a-z][a-z0-9-]{1,30}$/.test(String(m.id))) problems.push('id must be lowercase letters/digits/dashes');
  if (!m.name || !m.tab) problems.push('name and tab are required');
  if (!/^\d+\.\d+\.\d+$/.test(String(m.version))) problems.push('version must be semver (x.y.z)');
  if (!['demo', 'live', 'both'].includes(m.mode)) problems.push('mode must be demo | live | both');
  if (m.mode !== 'live' && !m.demo) problems.push('mode demo/both requires "demo": true (a demo.js)');
  if (m.mode !== 'demo' && !m.server && !(m.needs || []).length) problems.push('mode live/both needs a server step or "needs" blocks that the core snapshot provides');
  for (const k of ['demo', 'server', 'style']) if (m[k] !== undefined && typeof m[k] !== 'boolean') problems.push(`${k} must be boolean`);
  if (m.needs !== undefined && !Array.isArray(m.needs)) problems.push('needs must be an array of snapshot paths');
  return problems;
}

export async function loadFeatures(ids = FEATURES) {
  const out = [];
  for (const id of ids) {
    try {
      const manifest = await readManifest(id);
      const problems = validateManifest(manifest, id);
      if (problems.length) throw new Error(problems.join('; '));
      const view = await import(modUrl(id, 'view.js'));
      if (typeof view.render !== 'function') throw new Error('view.js must export render(ctx)');
      const demo = manifest.demo ? await import(modUrl(id, 'demo.js')) : null;
      if (demo && typeof demo.demo !== 'function') throw new Error('demo.js must export demo(snapshot)');
      out.push({ id, manifest, view, demo });
    } catch (err) {
      // A broken feature never takes the dashboard down: it is listed as failed and skipped.
      out.push({ id, manifest: null, error: err.message });
      if (!isNode) console.error(`[feature ${id}]`, err);
    }
  }
  return out;
}

/** Attach every feature's demo block to a demo snapshot (mutates + returns it). */
export function applyDemoFeatures(snapshot, features) {
  for (const f of features) {
    if (!f.demo) continue;
    try { snapshot[f.id] = f.demo.demo(snapshot); }
    catch (err) { snapshot[f.id] = { error: `demo: ${err.message}` }; }
  }
  return snapshot;
}

/** Does the snapshot carry what the feature declares it needs? */
export function needsMet(manifest, snapshot) {
  return (manifest.needs || []).every((path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), snapshot) !== undefined);
}
